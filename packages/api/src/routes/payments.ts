// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and, inArray, like } from 'drizzle-orm';
import { db, client, writeAudit, settingAuditLog, siteAuditLog } from '@evtivity/database';
import {
  sitePaymentConfigs,
  driverPaymentMethods,
  paymentRecords,
  paymentReconciliationRuns,
  chargingSessions,
  settings,
  chargingStations,
  sites,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  encryptString,
  decryptString,
  dispatchDriverNotification,
  notificationMoney,
} from '@evtivity/lib';
import {
  authorizeSessionHold,
  captureSessionHold,
  PaymentProviderNotConfiguredError,
  refundPaymentRecord,
  removeDriverMethod,
  retryShortfallForRecord,
  runPaymentReconciliation,
  saveDriverMethod,
  setDefaultDriverMethod,
  startDriverMethodSetup,
} from '@evtivity/payments';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';
import type { JwtPayload } from '../plugins/auth.js';
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { config as apiConfig } from '../lib/config.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const sitePaymentConfigItem = z
  .object({
    id: z.string().describe('Site payment configuration ID'),
    siteId: z.string().describe('Site ID this payment configuration belongs to'),
    stripeConnectedAccountId: z
      .string()
      .max(255)
      .nullable()
      .describe('Stripe Connect account ID for the site, if using a connected account'),
    preAuthAmountCents: z.number().int().min(0).describe('Pre-authorization hold amount in cents'),
    platformFeePercent: z
      .string()
      .nullable()
      .describe(
        'Site-level platform fee percentage override (numeric string, null = use global default)',
      ),
    isEnabled: z.boolean().describe('Whether payments are enabled for this site'),
    createdAt: z.coerce.date().describe('Timestamp when the configuration was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the configuration was last updated'),
  })
  .passthrough();

const stripeSettingsResponse = z
  .object({
    publishableKey: z
      .unknown()
      .nullable()
      .describe('Stripe publishable API key for client-side Stripe.js'),
    secretKey: z
      .string()
      .nullable()
      .describe('Stripe secret API key (decrypted from storage; null when unset)'),
    webhookSecret: z
      .string()
      .nullable()
      .describe(
        'Stripe webhook signing secret for POST /v1/webhooks/stripe (decrypted from storage; null when unset)',
      ),
    preAuthAmountCents: z.unknown().describe('Default pre-authorization amount in cents'),
    platformFeePercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Default platform fee percentage (0-100)'),
  })
  .passthrough();

const driverPaymentMethodItem = z
  .object({
    id: z.string().describe('Payment method ID'),
    driverId: z.string().describe('Driver ID this payment method belongs to'),
    stripeCustomerId: z.string().max(255).describe('Stripe Customer identifier for the driver'),
    stripePaymentMethodId: z.string().max(255).describe('Stripe PaymentMethod identifier used'),
    cardBrand: z
      .string()
      .max(20)
      .nullable()
      .describe('Card network (visa, mastercard, amex, etc.)'),
    cardLast4: z.string().length(4).nullable().describe('Last 4 digits of the card used'),
    isDefault: z.boolean().describe('True if this is the default payment method for the driver'),
    createdAt: z.coerce.date().describe('Timestamp when the payment method was added'),
    updatedAt: z.coerce.date().describe('Timestamp when the payment method was last updated'),
  })
  .passthrough();

const setupIntentResponse = z
  .object({
    provider: z.string().describe('Payment provider the card is added with (stripe, simulated)'),
    clientSecret: z
      .string()
      .nullable()
      .describe('Stripe SetupIntent client secret used to confirm the setup on the client'),
    customerId: z.string().max(255).describe('Stripe Customer identifier for the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable API key for client-side Stripe.js'),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.string().describe('Payment record ID'),
    sessionId: z.string().nullable().describe('Charging session ID linked to this payment'),
    driverId: z.string().nullable().describe('Driver ID linked to this payment'),
    sitePaymentConfigId: z
      .string()
      .nullable()
      .describe('Site payment configuration ID used for this payment'),
    stripePaymentIntentId: z
      .string()
      .max(255)
      .nullable()
      .describe('Stripe PaymentIntent identifier'),
    stripeCustomerId: z
      .string()
      .max(255)
      .nullable()
      .describe('Stripe Customer identifier for the driver'),
    paymentSource: z
      .string()
      .max(50)
      .nullable()
      .describe('Origin of the payment (e.g. web_portal, guest_checkout)'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    preAuthAmountCents: z.number().int().min(0).describe('Pre-authorization hold amount in cents'),
    capturedAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Amount captured from the pre-authorization in cents'),
    refundedAmountCents: z.number().int().min(0).describe('Total amount refunded in cents'),
    status: z
      .enum([
        'pending',
        'pre_authorized',
        'captured',
        'partially_refunded',
        'refunded',
        'failed',
        'cancelled',
      ])
      .describe('Payment lifecycle state'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .describe('Error message returned by Stripe when the payment failed'),
    lastActorUserId: z
      .string()
      .nullable()
      .optional()
      .describe('Operator user ID that performed the most recent action (refund, retry capture)'),
    lastActionReason: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe('Reason recorded for the most recent operator action'),
    createdAt: z.coerce.date().describe('Timestamp when the payment record was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the payment record was last updated'),
  })
  .passthrough();

const preAuthFailedResponse = z
  .object({
    error: z.string().describe('Human-readable error message describing the pre-auth failure'),
    code: z.string().describe('Stable machine-readable error code'),
    paymentRecord: paymentRecordItem
      .nullable()
      .describe(
        'Payment record of the failed pre-authorization (the session already had one when not new)',
      ),
  })
  .passthrough();

const reconciliationRunItem = z
  .object({
    id: z.string().describe('Reconciliation run ID'),
    checkedCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records checked against Stripe'),
    matchedCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that matched Stripe state'),
    discrepancyCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that did not match Stripe state'),
    errorCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that errored during reconciliation'),
    discrepancies: z
      .array(z.unknown())
      .nullable()
      .describe('Detailed discrepancy entries from this reconciliation run'),
    errors: z
      .array(z.unknown())
      .nullable()
      .describe('Detailed error entries from this reconciliation run'),
    createdAt: z.coerce.date().describe('Timestamp when the reconciliation run completed'),
  })
  .passthrough();

const reconciliationResultItem = z
  .object({
    checked: z.number().int().min(0).describe('Number of payment records checked against Stripe'),
    matched: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that matched Stripe state'),
    discrepancies: z
      .array(z.unknown())
      .describe('Detailed discrepancy entries found during reconciliation'),
    errors: z
      .array(z.unknown())
      .describe('Detailed error entries encountered during reconciliation'),
  })
  .passthrough();
import { authorize } from '../middleware/rbac.js';
import { clearPaymentCaches, paymentContext, paymentRegistry } from '../lib/payments.js';

const siteIdParams = z.object({ id: ID_PARAMS.siteId.describe('Site ID') });
const driverIdParams = z.object({ id: ID_PARAMS.driverId.describe('Driver ID') });
const sessionIdParams = z.object({ id: ID_PARAMS.sessionId.describe('Charging session ID') });
const paymentMethodParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
  pmId: z.coerce.number().int().min(1).describe('Payment method ID'),
});

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

// --- Site payment config ---

const upsertSitePaymentConfigBody = z.object({
  stripeConnectedAccountId: z.string().max(255).optional(),
  preAuthAmountCents: z
    .number()
    .int()
    .min(0)
    .default(5000)
    .describe('Pre-authorization hold amount in cents'),
  platformFeePercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe('Site-level platform fee override (null = use global default)'),
  isEnabled: z.boolean().default(true).describe('Whether payments are enabled for this site'),
});

// --- Driver payment methods ---

const savePaymentMethodBody = z.object({
  stripePaymentMethodId: z.string().min(1).describe('Stripe payment method ID'),
  stripeCustomerId: z.string().min(1).describe('Stripe customer ID'),
  cardBrand: z.string().max(20).optional().describe('Card brand (e.g. Visa, Mastercard)'),
  cardLast4: z.string().max(4).optional().describe('Last 4 digits of the card number'),
});

// --- Session payments ---

const preAuthorizeBody = z.object({
  paymentMethodId: z.coerce.number().int().min(1).describe('Payment method ID to charge'),
  amountCents: z.number().int().min(0).optional().describe('Override pre-auth amount in cents'),
});

const captureBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Amount to capture in cents, defaults to session cost'),
});

const refundBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Partial refund amount in cents, defaults to full refund'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Free-text reason recorded on the audit trail for this refund'),
});

// --- System Stripe settings ---

const updateStripeSettingsBody = z.object({
  secretKey: z.string().min(1).optional().describe('Stripe secret API key (stored encrypted)'),
  publishableKey: z.string().min(1).optional().describe('Stripe publishable API key'),
  webhookSecret: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stripe webhook signing secret (whsec_...) of the endpoint /v1/webhooks/stripe (stored encrypted)',
    ),
  preAuthAmountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Default pre-authorization amount in cents'),
  platformFeePercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Platform fee percentage (0-100)'),
});

export function paymentRoutes(app: FastifyInstance): void {
  // ---- Site Payment Config ----

  app.get(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get payment configuration for a site',
        operationId: 'getSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(sitePaymentConfigItem),
          404: errorWith('Payment config not found', [ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      const [config] = await db
        .select({
          id: sitePaymentConfigs.id,
          siteId: sitePaymentConfigs.siteId,
          stripeConnectedAccountId: sitePaymentConfigs.stripeConnectedAccountId,
          preAuthAmountCents: sitePaymentConfigs.preAuthAmountCents,
          platformFeePercent: sitePaymentConfigs.platformFeePercent,
          isEnabled: sitePaymentConfigs.isEnabled,
          createdAt: sitePaymentConfigs.createdAt,
          updatedAt: sitePaymentConfigs.updatedAt,
        })
        .from(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id));

      if (config == null) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }
      return config;
    },
  );

  async function writeSitePaymentConfigAudit(
    request: FastifyRequest,
    siteId: string,
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    const actor = getAuditActor(request);
    await writeAudit(
      { table: siteAuditLog, idColumn: 'site_id' },
      {
        entityId: siteId,
        entityIdSnapshot: siteId,
        action: 'payment_config_changed',
        ...actor,
        before: before ?? null,
        after: after ?? null,
      },
      db,
      request.log,
    );
  }

  app.put(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create or update payment configuration for a site',
        operationId: 'upsertSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        body: zodSchema(upsertSitePaymentConfigBody),
        response: {
          200: itemResponse(sitePaymentConfigItem),
          404: errorWith('Site or payment config not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      const body = request.body as z.infer<typeof upsertSitePaymentConfigBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      // The siteIds filter above only guards non-all-access operators.
      // All-site-access admins still need an explicit site existence check
      // so the INSERT below cannot create a row with a dangling siteId FK.
      const [siteRow] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (siteRow == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id));

      if (existing != null) {
        const [updated] = await db
          .update(sitePaymentConfigs)
          .set({
            stripeConnectedAccountId: body.stripeConnectedAccountId ?? null,
            preAuthAmountCents: body.preAuthAmountCents,
            platformFeePercent:
              body.platformFeePercent != null ? String(body.platformFeePercent) : null,
            isEnabled: body.isEnabled,
            updatedAt: new Date(),
          })
          .where(eq(sitePaymentConfigs.siteId, id))
          .returning();
        clearPaymentCaches();
        await writeSitePaymentConfigAudit(request, id, existing, updated);
        return updated;
      }

      let created;
      try {
        [created] = await db
          .insert(sitePaymentConfigs)
          .values({
            siteId: id,
            stripeConnectedAccountId: body.stripeConnectedAccountId ?? null,
            preAuthAmountCents: body.preAuthAmountCents,
            platformFeePercent:
              body.platformFeePercent != null ? String(body.platformFeePercent) : null,
            isEnabled: body.isEnabled,
          })
          .returning();
      } catch (err) {
        // Pre-check is non-transactional, so the site can be deleted between
        // the check and this INSERT. Map the FK violation back to 404.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23503'
        ) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
        throw err;
      }
      clearPaymentCaches();
      await writeSitePaymentConfigAudit(request, id, null, created);
      return created;
    },
  );

  app.delete(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Delete payment configuration for a site',
        operationId: 'deleteSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: successResponse,
          404: errorWith('Payment config not found', [ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      let deleted;
      try {
        [deleted] = await db
          .delete(sitePaymentConfigs)
          .where(eq(sitePaymentConfigs.siteId, id))
          .returning();
      } catch (err) {
        // payment_records.site_payment_config_id references this row with no
        // cascade. Log the FK violation distinctly so operators can find it
        // in logs; the global handler turns it into a 500 (a dedicated 409
        // code would need updates across error-codes + 6 locales + docs).
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23503'
        ) {
          request.log.warn(
            { sitePaymentConfigSiteId: id },
            'Cannot delete site_payment_config: referenced by existing payment_records',
          );
        }
        throw err;
      }

      if (deleted == null) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }
      clearPaymentCaches();
      await writeSitePaymentConfigAudit(request, id, deleted, null);
      return { success: true };
    },
  );

  // ---- System Stripe Settings ----

  app.get(
    '/settings/stripe',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get system Stripe settings',
        operationId: 'getStripeSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(stripeSettingsResponse) },
      },
    },
    async () => {
      // Push the stripe.* prefix filter to Postgres so the admin Settings
      // page doesn't drag the entire settings table over the wire just to
      // pick four keys.
      const rows = await db.select().from(settings).where(like(settings.key, 'stripe.%'));
      const map = new Map<string, unknown>();
      for (const row of rows) {
        map.set(row.key, row.value);
      }
      const encryptionKey = getEncryptionKey();
      const decryptSetting = (key: string): string | null => {
        const raw = map.get(key);
        return typeof raw === 'string' && raw !== '' ? decryptString(raw, encryptionKey) : null;
      };
      return {
        publishableKey: map.get('stripe.publishableKey') ?? null,
        secretKey: decryptSetting('stripe.secretKeyEnc'),
        webhookSecret: decryptSetting('stripe.webhookSecretEnc'),
        preAuthAmountCents: map.get('stripe.preAuthAmountCents') ?? 5000,
        platformFeePercent: Number(map.get('stripe.platformFeePercent') ?? 0),
      };
    },
  );

  app.put(
    '/settings/stripe',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Update system Stripe settings',
        operationId: 'updateStripeSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateStripeSettingsBody),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof updateStripeSettingsBody>;
      const encryptionKey = getEncryptionKey();

      const pairs: Array<{ key: string; value: unknown }> = [];

      if (body.secretKey != null) {
        pairs.push({
          key: 'stripe.secretKeyEnc',
          value: encryptString(body.secretKey, encryptionKey),
        });
      }
      if (body.publishableKey != null) {
        pairs.push({ key: 'stripe.publishableKey', value: body.publishableKey });
      }
      if (body.webhookSecret != null) {
        pairs.push({
          key: 'stripe.webhookSecretEnc',
          value: encryptString(body.webhookSecret, encryptionKey),
        });
      }
      if (body.preAuthAmountCents != null) {
        pairs.push({ key: 'stripe.preAuthAmountCents', value: body.preAuthAmountCents });
      }
      if (body.platformFeePercent != null) {
        pairs.push({ key: 'stripe.platformFeePercent', value: body.platformFeePercent });
      }

      // Until the provider select of the Payment settings (plan P5), saving
      // a Stripe secret key selects Stripe when no provider is selected, as
      // entering the keys turned payments on before the provider setting.
      if (body.secretKey != null) {
        const [current] = await db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'payments.provider'));
        if (current?.value == null || current.value === '' || current.value === 'none') {
          pairs.push({ key: 'payments.provider', value: 'stripe' });
        }
      }

      const keysToWrite = pairs.map((p) => p.key);
      const beforeRows =
        keysToWrite.length > 0
          ? await db.select().from(settings).where(inArray(settings.key, keysToWrite))
          : [];
      const beforeMap = new Map<string, unknown>();
      for (const row of beforeRows) beforeMap.set(row.key, row.value);

      for (const { key, value } of pairs) {
        await db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
      }

      clearPaymentCaches();

      const actor = getAuditActor(request);
      await Promise.allSettled(
        pairs
          .filter(({ key, value }) => beforeMap.get(key) !== value)
          .map(({ key, value }) =>
            writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: { key, value: beforeMap.get(key) },
                after: { key, value },
              },
              db,
              request.log,
            ),
          ),
      );

      return { success: true };
    },
  );

  // ---- Stripe Connection Test ----

  app.post(
    '/settings/stripe/test',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Test Stripe API connection',
        operationId: 'testStripeConnection',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (_request, reply) => {
      try {
        const provider = await paymentRegistry.getPaymentProvider('stripe');
        await provider.testConnection();
        return { success: true };
      } catch (err: unknown) {
        if (err instanceof PaymentProviderNotConfiguredError) {
          await reply.status(400).send({
            error: 'Stripe is not configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        }
        const message = err instanceof Error ? err.message : 'Connection failed';
        await reply.status(400).send({
          error: message,
          code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
        });
        return;
      }
    },
  );

  // ---- All Site Payment Configs ----

  app.get(
    '/sites/payment-configs',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List all site payment configurations',
        operationId: 'listSitePaymentConfigs',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(sitePaymentConfigItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];
      if (siteIds != null) {
        return db
          .select()
          .from(sitePaymentConfigs)
          .where(inArray(sitePaymentConfigs.siteId, siteIds));
      }
      return db.select().from(sitePaymentConfigs);
    },
  );

  // ---- Driver Payment Methods ----

  app.get(
    '/drivers/:id/payment-methods',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List payment methods for a driver',
        operationId: 'listDriverPaymentMethods',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        response: { 200: arrayResponse(driverPaymentMethodItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      return db.select().from(driverPaymentMethods).where(eq(driverPaymentMethods.driverId, id));
    },
  );

  app.post(
    '/drivers/:id/payment-methods/setup-intent',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create a Stripe setup intent for a driver',
        operationId: 'createDriverSetupIntent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        response: {
          200: itemResponse(setupIntentResponse),
          400: errorWith('Stripe not configured', [ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const result = await startDriverMethodSetup(
        { driverId: id, channel: 'web' },
        paymentContext(request.log),
      );
      if (result.status === 'driver_not_found') {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      if (result.status === 'not_configured') {
        await reply.status(400).send({
          error: 'No payment provider configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      if (result.status === 'failed') {
        await reply.status(400).send({
          error: `The payment provider rejected the request: ${result.reason}`,
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const session = result.session as { clientSecret?: unknown; publishableKey?: unknown };
      return {
        provider: result.providerId,
        clientSecret: typeof session.clientSecret === 'string' ? session.clientSecret : null,
        customerId: result.customerId,
        publishableKey: typeof session.publishableKey === 'string' ? session.publishableKey : '',
      };
    },
  );

  app.post(
    '/drivers/:id/payment-methods',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Save a payment method for a driver',
        operationId: 'createDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        body: zodSchema(savePaymentMethodBody),
        response: {
          201: itemResponse(driverPaymentMethodItem),
          400: errorWith('Payment provider not configured', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          403: errorWith('Method not attached to the customer', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;
      // The operator adds a card for the driver: a driver without a customer
      // takes the customer of the setup; the provider checks the method is
      // attached to it.
      const result = await saveDriverMethod(
        {
          driverId: id,
          customerId: body.stripeCustomerId,
          methodId: body.stripePaymentMethodId,
          adoptCustomer: true,
        },
        paymentContext(request.log),
      );
      switch (result.status) {
        case 'saved':
          await reply.status(201).send(result.method);
          return;
        case 'driver_not_found':
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        case 'forbidden':
          await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
          return;
        case 'not_initialized':
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'verify_failed':
          await reply.status(400).send({
            error: 'Could not verify payment method',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
      }
    },
  );

  app.delete(
    '/drivers/:id/payment-methods/:pmId',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Delete a payment method for a driver',
        operationId: 'deleteDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: successResponse,
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pmId } = request.params as z.infer<typeof paymentMethodParams>;
      const result = await removeDriverMethod(
        { driverId: id, methodRowId: pmId, blockWhenInUse: false },
        paymentContext(request.log),
      );
      if (result.status === 'not_found') {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      return { success: true };
    },
  );

  app.patch(
    '/drivers/:id/payment-methods/:pmId/default',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Set a payment method as default for a driver',
        operationId: 'setDefaultDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: itemResponse(driverPaymentMethodItem),
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pmId } = request.params as z.infer<typeof paymentMethodParams>;
      const updated = await setDefaultDriverMethod(id, pmId);
      if (updated == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      return updated;
    },
  );

  // ---- Session Payments ----

  app.post(
    '/sessions/:id/pre-authorize',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Pre-authorize a payment for a charging session',
        operationId: 'preAuthorizeSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(preAuthorizeBody),
        response: {
          200: itemResponse(paymentRecordItem),
          400: itemResponse(preAuthFailedResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.PAYMENT_METHOD_NOT_FOUND,
            ERROR_CODES.SESSION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof preAuthorizeBody>;

      const [session] = await db
        .select({
          id: chargingSessions.id,
          driverId: chargingSessions.driverId,
          siteId: chargingStations.siteId,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(chargingSessions.id, id));
      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // Same key as the portal start and the OCPP gate (preauth_<sessionId>,
      // P7): a retried request, or a pre-auth after the gate already placed
      // one, returns the existing record instead of a second hold.
      const outcome = await authorizeSessionHold(
        {
          sessionId: session.id,
          driverId: session.driverId,
          methodRowId: body.paymentMethodId,
          siteId: session.siteId,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          trigger: 'operator',
        },
        paymentContext(request.log),
      );
      const recordOf = async (recordId: number | null): Promise<unknown> => {
        if (recordId == null) return null;
        const [row] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, recordId));
        return row ?? null;
      };
      switch (outcome.outcome) {
        case 'authorized':
          return recordOf(outcome.paymentRecordId);
        case 'exists': {
          const existing = await recordOf(outcome.paymentRecordId);
          if (outcome.status === 'pre_authorized') return existing;
          await reply.status(400).send({
            error: 'The session already has a payment record',
            code: 'PRE_AUTH_FAILED',
            paymentRecord: existing,
          });
          return;
        }
        case 'declined': {
          const [record] =
            outcome.paymentRecordId != null
              ? await db
                  .select()
                  .from(paymentRecords)
                  .where(eq(paymentRecords.id, outcome.paymentRecordId))
              : await db.select().from(paymentRecords).where(eq(paymentRecords.sessionId, id));
          await reply.status(400).send({
            error: outcome.reason,
            code: 'PRE_AUTH_FAILED',
            paymentRecord: record ?? null,
          });
          return;
        }
        case 'no_method':
          await reply.status(404).send({
            error: 'Payment method not found',
            code: 'PAYMENT_METHOD_NOT_FOUND',
          });
          return;
        case 'not_configured':
          // The 400 body of this route carries the payment record (none here).
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
            paymentRecord: null,
          });
          return;
        case 'record_failed':
          // The hold was cancelled again; the global handler answers 500.
          throw new Error(`Failed to record the pre-authorization: ${outcome.reason}`);
      }
    },
  );

  app.post(
    '/sessions/:id/capture',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Capture a pre-authorized payment for a session',
        description:
          'Captures a previously pre-authorized PaymentIntent in Stripe up to the supplied amount and updates the payment record to captured. When the requested amount is zero, the PaymentIntent is cancelled instead. Returns 400 if the payment is not in pre_authorized state.',
        operationId: 'captureSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(captureBody),
        response: {
          200: itemResponse(paymentRecordItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('No pre auth', [ERROR_CODES.NO_PRE_AUTH]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof captureBody>;
      // The session's final cost when no amount is given; a 0 amount cancels
      // the hold. The platform fee is a percent of the net amount captured.
      const outcome = await captureSessionHold(
        { sessionId: id, ...(body.amountCents != null ? { amountCents: body.amountCents } : {}) },
        paymentContext(request.log),
      );
      switch (outcome.status) {
        case 'no_hold':
          await reply.status(404).send({
            error: 'No pre-authorized payment for this session',
            code: 'NO_PRE_AUTH',
          });
          return;
        case 'missing_payment_id':
          await reply.status(400).send({
            error: 'Payment intent missing',
            code: 'MISSING_PAYMENT_INTENT',
          });
          return;
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        default:
          return outcome.record;
      }
    },
  );

  app.post(
    '/sessions/:id/refund',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Refund a captured payment for a session',
        description:
          'Issues a Stripe refund against the payment record for the session. Supports partial refunds via amountCents; defaults to a full refund of the remaining captured balance. Validates that the requested refund does not exceed the unrefunded captured amount. Locks the payment record row with SELECT FOR UPDATE so a concurrent capture or refund cannot interleave. Returns 409 REFUND_EXCEEDS_REMAINING when the requested amount is greater than what is still refundable.',
        operationId: 'refundSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(refundBody),
        response: {
          200: itemResponse(paymentRecordItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.NO_CAPTURED_PAYMENT,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
          409: errorWith('Refund exceeds remaining', [ERROR_CODES.REFUND_EXCEEDS_REMAINING]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof refundBody>;
      const { userId } = request.user as JwtPayload;

      // Site access first, before any payment-state answer: otherwise an
      // operator without access could probe a restricted site's sessions
      // through the response codes.
      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id));
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station?.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // The record is locked for the refund, and the request key
      // <recordId>_<refundedSoFar>_<amount> makes a retry reuse the refund
      // while a later partial refund gets its own (P7).
      const outcome = await refundPaymentRecord(
        {
          sessionId: id,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          actorUserId: userId,
          actionReason: (full) => body.reason ?? (full ? 'Full refund' : 'Partial refund'),
        },
        paymentContext(request.log),
      );
      switch (outcome.status) {
        case 'no_captured_payment':
          await reply.status(400).send({
            error: 'No captured payment to refund',
            code: 'NO_CAPTURED_PAYMENT',
          });
          return;
        case 'missing_payment_id':
          await reply.status(400).send({
            error: 'Payment intent missing',
            code: 'MISSING_PAYMENT_INTENT',
          });
          return;
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'nothing_refundable':
        case 'exceeds_remaining': {
          const requested = outcome.status === 'exceeds_remaining' ? outcome.requestedCents : 0;
          await reply.status(409).send({
            error: `Refund amount ${String(requested)} exceeds remaining refundable balance ${String(outcome.remainingCents)}`,
            code: 'REFUND_EXCEEDS_REMAINING',
          });
          return;
        }
        case 'refunded':
          break;
      }
      const updated = outcome.record;
      const refundedNowCents = outcome.refundedNowCents;

      // Driver notification: payment refunded. Fire-and-forget so a slow
      // SMTP/Twilio call does not delay the response; a failure is logged.
      if (updated.driverId != null) {
        dispatchDriverNotification(
          client,
          'payment.Refunded',
          updated.driverId,
          {
            amountCents: refundedNowCents,
            amountFormatted: notificationMoney(refundedNowCents, updated.currency),
            currency: updated.currency,
            transactionId: updated.sessionId,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        ).catch((err: unknown) => {
          request.log.warn(
            { err, paymentRecordId: updated.id, driverId: updated.driverId },
            'Failed to dispatch payment.Refunded notification',
          );
        });
      }

      return updated;
    },
  );

  app.get(
    '/sessions/:id/payment',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get payment record for a session',
        operationId: 'getSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: {
          200: itemResponse(paymentRecordItem),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const { userId } = request.user as JwtPayload;

      const [sessionRow] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(chargingSessions.id, id));

      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && sessionRow?.siteId != null && !siteIds.includes(sessionRow.siteId)) {
        await reply.status(404).send({
          error: 'No payment record for this session',
          code: 'PAYMENT_NOT_FOUND',
        });
        return;
      }

      const [record] = await db
        .select()
        .from(paymentRecords)
        .where(eq(paymentRecords.sessionId, id));

      if (record == null) {
        await reply.status(404).send({
          error: 'No payment record for this session',
          code: 'PAYMENT_NOT_FOUND',
        });
        return;
      }
      return record;
    },
  );

  app.post(
    '/payments/:id/retry-capture',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Retry capture or top-up for a payment record',
        description:
          'Re-attempts capture for a payment record where the final cost exceeded the pre-auth and the top-up PaymentIntent previously failed (status=captured AND captured_amount_cents < session.final_cost_cents). Creates a new PaymentIntent for the unpaid delta and captures it. Returns 409 PAYMENT_RECORD_NOT_RECOVERABLE when the record has no shortfall or is in an unsupported state.',
        operationId: 'retryPaymentCapture',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.coerce.number().int().min(1) })),
        response: {
          200: itemResponse(paymentRecordItem),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
          409: errorWith('Payment record cannot be recovered or Stripe not configured', [
            ERROR_CODES.PAYMENT_RECORD_NOT_RECOVERABLE,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          502: errorWith('Stripe rejected the top-up payment intent', [
            ERROR_CODES.PAYMENT_TOP_UP_FAILED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const { userId } = request.user as JwtPayload;

      // Site access: operators with restricted site access can only retry
      // payments of sessions on their sites.
      const [row] = await db
        .select({ siteId: chargingStations.siteId })
        .from(paymentRecords)
        .innerJoin(chargingSessions, eq(chargingSessions.id, paymentRecords.sessionId))
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(paymentRecords.id, id));
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && row?.siteId != null && !siteIds.includes(row.siteId)) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // Same card and payout account, the platform fee of the increment, key
      // topup_retry_<recordId>_<captured> shared with the daily retry.
      const outcome = await retryShortfallForRecord(
        { recordId: id, actorUserId: userId },
        paymentContext(request.log),
      );
      switch (outcome.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
          return;
        case 'not_recoverable':
          await reply.status(409).send({
            error: outcome.reason,
            code: 'PAYMENT_RECORD_NOT_RECOVERABLE',
          });
          return;
        case 'not_configured':
          await reply.status(409).send({
            error: 'Payment provider not configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'failed':
          await reply.status(502).send({
            error: `The payment provider rejected the top-up: ${outcome.reason}`,
            code: 'PAYMENT_TOP_UP_FAILED',
          });
          return;
        case 'recovered':
          return outcome.record;
      }
    },
  );

  // ---- Reconciliation ----

  app.get(
    '/payments/reconciliation',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List payment reconciliation runs',
        operationId: 'listReconciliationRuns',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(reconciliationRunItem) },
      },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(paymentReconciliationRuns)
          .orderBy(desc(paymentReconciliationRuns.createdAt), desc(paymentReconciliationRuns.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(paymentReconciliationRuns),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.post(
    '/payments/reconciliation/run',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Run payment reconciliation against Stripe',
        operationId: 'runReconciliation',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(reconciliationResultItem) },
      },
    },
    async (request) => {
      return runPaymentReconciliation(paymentContext(request.log));
    },
  );

  app.get(
    '/payments',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List all payment records',
        operationId: 'listPayments',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(paymentRecordItem) },
      },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const { userId } = request.user as JwtPayload;
      const offset = (page - 1) * limit;

      // Site-access enforcement: payment records carry sensitive data
      // (Stripe PI IDs, customer IDs, captured amounts) and must be filtered
      // to the operator's allowed sites. Walk the session->station join to
      // derive each record's siteId.
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) {
        return { data: [], total: 0 } satisfies PaginatedResponse<
          typeof paymentRecords.$inferSelect
        >;
      }

      const conditions =
        siteIds != null
          ? [
              inArray(
                paymentRecords.sessionId,
                db
                  .select({ id: chargingSessions.id })
                  .from(chargingSessions)
                  .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
                  .where(inArray(chargingStations.siteId, siteIds)),
              ),
            ]
          : [];
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(paymentRecords)
          .where(whereClause)
          .orderBy(desc(paymentRecords.createdAt), desc(paymentRecords.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentRecords)
          .where(whereClause),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
