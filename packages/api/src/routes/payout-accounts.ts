// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, siteAuditLog, sites, writeAudit } from '@evtivity/database';
import {
  createSitePayoutAccount,
  findSitePayoutAccount,
  PaymentProviderNotConfiguredError,
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  refreshSitePayoutAccount,
} from '@evtivity/payments';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { clearPaymentCaches, paymentContext } from '../lib/payments.js';
import { countryToAlpha2 } from '../lib/country-code.js';
import {
  createPayoutInvite,
  openPayoutInvite,
  revokePayoutInvites,
} from '../services/payout-onboarding.service.js';

// A site host's Stripe Connect payout account (plan P3.5 Part C). The
// payments service `payout-accounts.ts` writes the account columns; the
// onboarding service writes the invite links. Destination charges go to the
// account only while its status is `active` (O5, fail closed).

const siteIdParams = z.object({ id: ID_PARAMS.siteId.describe('Site ID') });

const PAYOUT_STATES = ['onboarding', 'action_required', 'pending', 'active', 'disabled'] as const;

const payoutAccountResponse = z
  .object({
    accountId: z
      .string()
      .nullable()
      .describe('Stripe connected account ID of the site (acct_...), or null without one'),
    status: z
      .enum(PAYOUT_STATES)
      .nullable()
      .describe(
        'Payout account state as last read from Stripe: onboarding (details not submitted), action_required (information due), pending (Stripe is verifying), active (card_payments and transfers active; the only state that receives destination charges), disabled (rejected or not accessible). Null when never read.',
      ),
    details: z
      .object({
        capabilities: z
          .record(z.string(), z.enum(['active', 'inactive', 'pending', 'unrequested']))
          .describe('card_payments and transfers capability states'),
        detailsSubmitted: z.boolean().describe('Whether the site host submitted the onboarding'),
        requirementsDue: z
          .array(z.string())
          .describe('Stripe requirements currently due or past due (sorted, at most 20)'),
        disabledReason: z
          .string()
          .nullable()
          .describe(
            'Stripe disabled reason, or account_invalid for an account the platform cannot access',
          ),
      })
      .passthrough()
      .nullable()
      .describe('Details of the last read, or null when never read'),
    checkedAt: z.coerce.date().nullable().describe('When the status was last read from Stripe'),
    invite: z
      .object({
        expiresAt: z.coerce.date().describe('When the open onboarding link expires'),
        sentTo: z
          .string()
          .nullable()
          .describe('Address the link was emailed to, or null when it was only copied'),
        lastUsedAt: z.coerce.date().nullable().describe('When the site host last opened the link'),
      })
      .passthrough()
      .nullable()
      .describe('The open onboarding link of the site (never its token), or null'),
  })
  .passthrough();

const createPayoutAccountBody = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe("ISO 3166-1 alpha-2 country of the site host's business; default the site's country"),
  contactEmail: z
    .string()
    .email()
    .max(255)
    .optional()
    .describe(
      "Contact email of the site host's Stripe account; default the site contact email. Stripe requires one.",
    ),
});

const payoutInviteBody = z.object({
  send: z
    .enum(['email', 'none'])
    .describe('email sends the link to the site contact email; none only creates it to copy'),
});

const payoutInviteResponse = z
  .object({
    url: z
      .string()
      .describe(
        'EVtivity onboarding link (7 days) of the public portal page that opens Stripe onboarding',
      ),
    expiresAt: z.coerce.date().describe('When the link expires'),
    sentTo: z
      .string()
      .nullable()
      .describe('Address the link was emailed to, or null when it was only created'),
  })
  .passthrough();

const providerErrors = errorWith('Stripe is not configured or refused the call', [
  ERROR_CODES.VALIDATION_ERROR,
  ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
  ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
  ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
]);

/** 404 unless the operator may see the site (and it exists). Not 403, so existence does not leak. */
async function findAccessibleSite(
  request: FastifyRequest,
  reply: FastifyReply,
  siteId: string,
): Promise<{
  id: string;
  name: string;
  country: string | null;
  contactEmail: string | null;
} | null> {
  const { userId } = request.user as { userId: string };
  const siteIds = await getUserSiteIds(userId);
  const [site] =
    siteIds != null && !siteIds.includes(siteId)
      ? []
      : await db
          .select({
            id: sites.id,
            name: sites.name,
            country: sites.country,
            contactEmail: sites.contactEmail,
          })
          .from(sites)
          .where(eq(sites.id, siteId));
  if (site == null) {
    await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
    return null;
  }
  return site;
}

/**
 * 400 for a payout call that Stripe or the configuration refused; anything
 * else is rethrown for the global 500 handler.
 */
async function sendPayoutProviderError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): Promise<void> {
  if (err instanceof PaymentProviderNotConfiguredError) {
    await reply
      .status(400)
      .send({ error: 'Stripe is not configured', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
    return;
  }
  if (err instanceof PaymentProviderPermissionError) {
    await reply.status(400).send({
      error: err.message,
      code: 'PAYMENT_PROVIDER_PERMISSION_MISSING',
      permission: err.permission,
    });
    return;
  }
  if (err instanceof PaymentValidationError || err instanceof PaymentProviderUnavailableError) {
    request.log.warn({ error: err.message }, 'Stripe payout account call failed');
    await reply
      .status(400)
      .send({ error: err.message, code: 'PAYMENT_PROVIDER_CONNECTION_FAILED' });
    return;
  }
  throw err;
}

async function payoutAccountView(siteId: string): Promise<z.infer<typeof payoutAccountResponse>> {
  const [account, invite] = await Promise.all([
    findSitePayoutAccount(siteId),
    openPayoutInvite(siteId),
  ]);
  return {
    accountId: account?.accountId ?? null,
    status: account?.status ?? null,
    details: (account?.details ?? null) as z.infer<typeof payoutAccountResponse>['details'],
    checkedAt: account?.checkedAt ?? null,
    invite,
  };
}

export function payoutAccountRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:id/payout-account',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get the payout account of a site',
        description:
          'The Stripe Connect account that receives the destination charges of the site, its status as last read from Stripe, and the open onboarding link (without its token).',
        operationId: 'getSitePayoutAccount',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(payoutAccountResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      if ((await findAccessibleSite(request, reply, id)) == null) return;
      return payoutAccountView(id);
    },
  );

  app.post(
    '/sites/:id/payout-account',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create the Stripe payout account of a site',
        description:
          "Creates a Stripe Connect account (Accounts v2, Express dashboard, the platform collects fees and carries losses) for the site host and stores it on the site's payment config (created disabled when the site has none). The display name is the site name, the contact email the body's contactEmail or the site contact email (Stripe requires one, so the call answers 400 VALIDATION_ERROR without either), the country the body's country or the site's country. The site host then onboards through the onboarding link. Stripe must have Connect enabled and the platform's loss responsibilities acknowledged.",
        operationId: 'createSitePayoutAccount',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        body: zodSchema(createPayoutAccountBody),
        response: {
          200: itemResponse(payoutAccountResponse),
          400: providerErrors,
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('The site already has a payout account', [
            ERROR_CODES.PAYOUT_ACCOUNT_EXISTS,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      const body = request.body as z.infer<typeof createPayoutAccountBody>;
      const site = await findAccessibleSite(request, reply, id);
      if (site == null) return;

      const country = countryToAlpha2(body.country ?? site.country);
      if (country == null) {
        await reply.status(400).send({
          error: 'Country required',
          code: 'VALIDATION_ERROR',
          details: {
            country:
              "The site's country is not an ISO 3166-1 country; send the country as an alpha-2 code",
          },
        });
        return;
      }

      // Stripe refuses an account with the recipient configuration and no
      // contact email, so refuse before calling it.
      const contactEmail =
        body.contactEmail ??
        (site.contactEmail != null && site.contactEmail !== '' ? site.contactEmail : null);
      if (contactEmail == null) {
        await reply.status(400).send({
          error: 'Contact email required',
          code: 'VALIDATION_ERROR',
          details: {
            contactEmail:
              'The site has no contact email; send the contact email of the site host in contactEmail',
          },
        });
        return;
      }

      let outcome;
      try {
        outcome = await createSitePayoutAccount(
          id,
          { displayName: site.name, contactEmail, country },
          paymentContext(request.log),
        );
      } catch (err) {
        await sendPayoutProviderError(request, reply, err);
        return;
      }
      switch (outcome.outcome) {
        case 'not_supported':
          await reply.status(400).send({
            error: 'The payment provider cannot create payout accounts',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'exists':
          await reply.status(409).send({
            error: 'The site already has a payout account',
            code: 'PAYOUT_ACCOUNT_EXISTS',
            accountId: outcome.accountId,
          });
          return;
        case 'created':
          clearPaymentCaches();
          await writeAudit(
            { table: siteAuditLog, idColumn: 'site_id' },
            {
              entityId: id,
              entityIdSnapshot: id,
              action: 'payment_config_changed',
              ...getAuditActor(request),
              after: { payoutAccountId: outcome.accountId },
              notes: 'Payout account created',
            },
            db,
            request.log,
          );
          return payoutAccountView(id);
      }
    },
  );

  app.post(
    '/sites/:id/payout-account/refresh',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Read the payout account status from Stripe',
        description:
          'Reads the payout account from Stripe and stores its status. An account that became active revokes the open onboarding link.',
        operationId: 'refreshSitePayoutAccount',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(payoutAccountResponse),
          400: providerErrors,
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('The site has no payout account', [ERROR_CODES.PAYOUT_ACCOUNT_NOT_READY]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      if ((await findAccessibleSite(request, reply, id)) == null) return;
      let status;
      try {
        status = await refreshSitePayoutAccount(id, paymentContext(request.log));
      } catch (err) {
        await sendPayoutProviderError(request, reply, err);
        return;
      }
      if (status == null) {
        await reply.status(409).send({
          error: 'The site has no payout account',
          code: 'PAYOUT_ACCOUNT_NOT_READY',
        });
        return;
      }
      if (status.state === 'active') await revokePayoutInvites(id);
      return payoutAccountView(id);
    },
  );

  app.post(
    '/sites/:id/payout-account/invite',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create the onboarding link of a site payout account',
        description:
          'Creates a 7-day EVtivity link for the site host and revokes the older ones. The link opens a public portal page that starts Stripe onboarding (a fresh Stripe link on each visit; the Stripe link is never emailed). With send: email the link is emailed to the site contact (notification site.PayoutOnboarding).',
        operationId: 'createSitePayoutInvite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        body: zodSchema(payoutInviteBody),
        response: {
          200: itemResponse(payoutInviteResponse),
          400: errorWith('The site has no contact email', [ERROR_CODES.EMAIL_REQUIRED]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('The site has no payout account', [ERROR_CODES.PAYOUT_ACCOUNT_NOT_READY]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      const body = request.body as z.infer<typeof payoutInviteBody>;
      if ((await findAccessibleSite(request, reply, id)) == null) return;
      return createPayoutInvite(
        id,
        { send: body.send },
        { actor: getAuditActor(request), log: request.log },
      );
    },
  );
}
