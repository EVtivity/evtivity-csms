// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createSitePayoutOnboardingLink,
  PaymentProviderNotConfiguredError,
  refreshSitePayoutAccount,
} from '@evtivity/payments';
import { zodSchema } from '../../lib/zod-schema.js';
import { itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { config as apiConfig } from '../../lib/config.js';
import { paymentContext } from '../../lib/payments.js';
import {
  payoutOnboardingReturnUrl,
  payoutOnboardingUrl,
  resolvePayoutInvite,
} from '../../services/payout-onboarding.service.js';

// Public pages of the site host's payout onboarding (plan P3.5 O4). The
// site host has no EVtivity login: the 7-day EVtivity link is the
// credential. The portal page reads the token from its URL and posts it in
// the body, so it is not a path segment in access logs (the access log
// redacts body fields named token).

const tokenBody = z.object({
  token: z
    .string()
    .min(1)
    .max(128)
    .describe('Token of the onboarding link the operator created or emailed'),
});

const PAYOUT_STATES = ['onboarding', 'action_required', 'pending', 'active', 'disabled'] as const;

const linkResponse = z
  .object({
    url: z
      .string()
      .nullable()
      .describe(
        'Stripe-hosted onboarding link (single use, expires after minutes; open it at once), or null when the account is already active',
      ),
    status: z
      .enum(PAYOUT_STATES)
      .nullable()
      .describe('active when there is nothing to onboard, else null'),
  })
  .passthrough();

const statusResponse = z
  .object({
    status: z
      .enum(PAYOUT_STATES)
      .describe(
        'Payout account state read from Stripe: onboarding, action_required, pending (Stripe is verifying), active, disabled',
      ),
  })
  .passthrough();

const rateLimit = {
  rateLimit: { max: apiConfig.AUTH_RATE_LIMIT_MAX, timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW },
};

const providerErrors = errorWith('Invalid link, or Stripe refused the call', [
  ERROR_CODES.INVALID_TOKEN,
  ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
]);

async function sendNotAvailable(reply: FastifyReply): Promise<void> {
  await reply.status(400).send({
    error: 'Payout onboarding is not available',
    code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
  });
}

export function portalPayoutOnboardingRoutes(app: FastifyInstance): void {
  app.post(
    '/portal/payout-onboarding/link',
    {
      schema: {
        tags: ['Portal Payout Onboarding'],
        summary: 'Start Stripe onboarding from a payout onboarding link',
        description:
          "Mints a fresh Stripe Account Link for the site's payout account. Stripe sends the site host back to the portal onboarding page when the link expires (refresh) and to the return page when done. Returns 400 INVALID_TOKEN for an unknown, replaced or expired link.",
        operationId: 'portalPayoutOnboardingLink',
        security: [],
        body: zodSchema(tokenBody),
        response: {
          200: itemResponse(linkResponse),
          400: providerErrors,
        },
      },
      config: rateLimit,
    },
    async (request, reply) => {
      const { token } = request.body as z.infer<typeof tokenBody>;
      const { siteId } = await resolvePayoutInvite(token);
      let outcome;
      try {
        outcome = await createSitePayoutOnboardingLink(
          siteId,
          { refreshUrl: payoutOnboardingUrl(token), returnUrl: payoutOnboardingReturnUrl(token) },
          paymentContext(request.log),
        );
      } catch (err) {
        if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
        await sendNotAvailable(reply);
        return;
      }
      switch (outcome.outcome) {
        case 'link':
          return { url: outcome.url, status: null };
        case 'active':
          return { url: null, status: 'active' as const };
        case 'no_account':
          // The account was removed after the link was sent.
          await reply
            .status(400)
            .send({ error: 'Invalid or expired onboarding link', code: 'INVALID_TOKEN' });
          return;
        case 'not_supported':
          await sendNotAvailable(reply);
          return;
      }
    },
  );

  app.post(
    '/portal/payout-onboarding/status',
    {
      schema: {
        tags: ['Portal Payout Onboarding'],
        summary: 'Read the payout account status after Stripe onboarding',
        description:
          'Reads the payout account from Stripe (the return page; returning from Stripe does not mean onboarding is complete) and answers only its state.',
        operationId: 'portalPayoutOnboardingStatus',
        security: [],
        body: zodSchema(tokenBody),
        response: {
          200: itemResponse(statusResponse),
          400: providerErrors,
        },
      },
      config: rateLimit,
    },
    async (request, reply) => {
      const { token } = request.body as z.infer<typeof tokenBody>;
      const { siteId } = await resolvePayoutInvite(token);
      let status;
      try {
        status = await refreshSitePayoutAccount(siteId, paymentContext(request.log));
      } catch (err) {
        if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
        await sendNotAvailable(reply);
        return;
      }
      if (status == null) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired onboarding link', code: 'INVALID_TOKEN' });
        return;
      }
      return { status: status.state };
    },
  );
}
