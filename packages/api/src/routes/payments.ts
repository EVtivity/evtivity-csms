// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and, inArray, like } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  sitePaymentConfigs,
  driverPaymentMethods,
  paymentRecords,
  paymentReconciliationRuns,
  chargingSessions,
  settings,
  drivers,
  chargingStations,
} from '@evtivity/database';
import { encryptString, dispatchDriverNotification } from '@evtivity/lib';
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
    currency: z.string().length(3).describe('ISO 4217 currency code'),
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
    currency: z.unknown().describe('Default ISO 4217 currency code'),
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
    paymentRecord: paymentRecordItem.describe(
      'Payment record created for the failed pre-authorization',
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
import {
  getStripeConfig,
  createPreAuthorization,
  capturePayment,
  cancelPaymentIntent,
  createRefund,
  createSetupIntent,
  createCustomer,
  detachPaymentMethod,
  clearConfigCache,
} from '../services/stripe.service.js';

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
  currency: z.string().length(3).default('USD').describe('ISO 4217 currency code'),
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
  currency: z.string().length(3).optional().describe('Default ISO 4217 currency code'),
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
          currency: sitePaymentConfigs.currency,
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
          404: errorWith('Payment config not found', [ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND]),
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

      const [existing] = await db
        .select({ id: sitePaymentConfigs.id })
        .from(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id));

      if (existing != null) {
        const [updated] = await db
          .update(sitePaymentConfigs)
          .set({
            stripeConnectedAccountId: body.stripeConnectedAccountId ?? null,
            currency: body.currency,
            preAuthAmountCents: body.preAuthAmountCents,
            platformFeePercent:
              body.platformFeePercent != null ? String(body.platformFeePercent) : null,
            isEnabled: body.isEnabled,
            updatedAt: new Date(),
          })
          .where(eq(sitePaymentConfigs.siteId, id))
          .returning();
        clearConfigCache();
        return updated;
      }

      const [created] = await db
        .insert(sitePaymentConfigs)
        .values({
          siteId: id,
          stripeConnectedAccountId: body.stripeConnectedAccountId ?? null,
          currency: body.currency,
          preAuthAmountCents: body.preAuthAmountCents,
          platformFeePercent:
            body.platformFeePercent != null ? String(body.platformFeePercent) : null,
          isEnabled: body.isEnabled,
        })
        .returning();
      clearConfigCache();
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

      const [deleted] = await db
        .delete(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id))
        .returning();

      if (deleted == null) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }
      clearConfigCache();
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
      return {
        publishableKey: map.get('stripe.publishableKey') ?? null,
        currency: map.get('stripe.currency') ?? 'USD',
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
      if (body.currency != null) {
        pairs.push({ key: 'stripe.currency', value: body.currency });
      }
      if (body.preAuthAmountCents != null) {
        pairs.push({ key: 'stripe.preAuthAmountCents', value: body.preAuthAmountCents });
      }
      if (body.platformFeePercent != null) {
        pairs.push({ key: 'stripe.platformFeePercent', value: body.platformFeePercent });
      }

      for (const { key, value } of pairs) {
        await db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
      }

      clearConfigCache();
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
      const config = await getStripeConfig(null);
      if (config == null) {
        await reply.status(400).send({
          error: 'Stripe is not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      try {
        await config.stripe.balance.retrieve();
        return { success: true };
      } catch (err: unknown) {
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

      const [driver] = await db
        .select({
          id: drivers.id,
          email: drivers.email,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
        })
        .from(drivers)
        .where(eq(drivers.id, id));

      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const config = await getStripeConfig(null);
      if (config == null) {
        await reply.status(400).send({
          error: 'No Stripe configuration available',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      // Find or create Stripe customer. Wrap the SDK calls so an invalid or
      // stale API key surfaces as PAYMENT_PROVIDER_NOT_CONFIGURED instead of a 500.
      const [existingMethod] = await db
        .select({ stripeCustomerId: driverPaymentMethods.stripeCustomerId })
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, id))
        .limit(1);

      try {
        let customerId: string;
        if (existingMethod != null) {
          customerId = existingMethod.stripeCustomerId;
        } else {
          const customer = await createCustomer(
            config,
            driver.email ?? '',
            `${driver.firstName} ${driver.lastName}`,
          );
          customerId = customer.id;
        }

        const setupIntent = await createSetupIntent(config, customerId);
        if (setupIntent.client_secret == null || setupIntent.client_secret === '') {
          await reply.status(400).send({
            error: 'Stripe returned an empty client secret',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        }
        return {
          clientSecret: setupIntent.client_secret,
          customerId,
          publishableKey: config.publishableKey,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Stripe call failed';
        request.log.warn({ err: message }, 'Stripe setup-intent failed');
        await reply.status(400).send({
          error: `Stripe is configured but the API rejected the request: ${message}`,
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
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
        response: { 201: itemResponse(driverPaymentMethodItem) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;

      // Check if this is the first method to make it default
      const existingMethods = await db
        .select({ id: driverPaymentMethods.id })
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, id));

      const isDefault = existingMethods.length === 0;

      const [method] = await db
        .insert(driverPaymentMethods)
        .values({
          driverId: id,
          stripeCustomerId: body.stripeCustomerId,
          stripePaymentMethodId: body.stripePaymentMethodId,
          cardBrand: body.cardBrand,
          cardLast4: body.cardLast4,
          isDefault,
        })
        .returning();

      await reply.status(201).send(method);
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

      const [method] = await db
        .select()
        .from(driverPaymentMethods)
        .where(and(eq(driverPaymentMethods.id, pmId), eq(driverPaymentMethods.driverId, id)));

      if (method == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }

      // Detach from Stripe
      const config = await getStripeConfig(null);
      if (config != null) {
        try {
          await detachPaymentMethod(config, method.stripePaymentMethodId);
        } catch {
          // Payment method may already be detached
        }
      }

      await db.delete(driverPaymentMethods).where(eq(driverPaymentMethods.id, pmId));

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

      const [method] = await db
        .select({ id: driverPaymentMethods.id })
        .from(driverPaymentMethods)
        .where(and(eq(driverPaymentMethods.id, pmId), eq(driverPaymentMethods.driverId, id)));

      if (method == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }

      // Unset all defaults for this driver
      await db
        .update(driverPaymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(driverPaymentMethods.driverId, id));

      // Set this one as default
      const [updated] = await db
        .update(driverPaymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(driverPaymentMethods.id, pmId))
        .returning();

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
          stationId: chargingSessions.stationId,
          driverId: chargingSessions.driverId,
        })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, id));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const [pm] = await db
        .select()
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.id, body.paymentMethodId));

      if (pm == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }

      // Get site for this station
      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .where(eq(chargingStations.id, session.stationId));

      const config = await getStripeConfig(station?.siteId ?? null);
      if (config == null) {
        await reply.status(400).send({
          error: 'No Stripe configuration available',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      try {
        const paymentIntent = await createPreAuthorization(
          config,
          pm.stripeCustomerId,
          pm.stripePaymentMethodId,
          body.amountCents,
        );

        const [record] = await db
          .insert(paymentRecords)
          .values({
            sessionId: session.id,
            driverId: session.driverId,
            sitePaymentConfigId: config.configId,
            stripePaymentIntentId: paymentIntent.id,
            stripeCustomerId: pm.stripeCustomerId,
            paymentSource: 'web_portal',
            currency: config.currency,
            preAuthAmountCents: body.amountCents ?? config.preAuthAmountCents,
            status: 'pre_authorized',
          })
          .returning();

        return record;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Pre-authorization failed';
        const [record] = await db
          .insert(paymentRecords)
          .values({
            sessionId: session.id,
            driverId: session.driverId,
            sitePaymentConfigId: config.configId,
            paymentSource: 'web_portal',
            currency: config.currency,
            preAuthAmountCents: body.amountCents ?? config.preAuthAmountCents,
            status: 'failed',
            failureReason: message,
          })
          .returning();

        await reply.status(400).send({
          error: message,
          code: 'PRE_AUTH_FAILED',
          paymentRecord: record,
        });
        return;
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

      const [record] = await db
        .select()
        .from(paymentRecords)
        .where(and(eq(paymentRecords.sessionId, id), eq(paymentRecords.status, 'pre_authorized')));

      if (record == null) {
        await reply.status(404).send({
          error: 'No pre-authorized payment for this session',
          code: 'NO_PRE_AUTH',
        });
        return;
      }

      if (record.stripePaymentIntentId == null) {
        await reply.status(400).send({
          error: 'Payment intent missing',
          code: 'MISSING_PAYMENT_INTENT',
        });
        return;
      }

      // Get session's final cost if no amount specified
      let amountCents = body.amountCents;
      if (amountCents == null) {
        const [session] = await db
          .select({ finalCostCents: chargingSessions.finalCostCents })
          .from(chargingSessions)
          .where(eq(chargingSessions.id, id));
        amountCents = session?.finalCostCents ?? 0;
      }

      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id));

      const config = await getStripeConfig(station?.siteId ?? null);
      if (config == null) {
        await reply.status(400).send({
          error: 'No Stripe configuration available',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      if (amountCents === 0) {
        // Cancel the pre-auth instead of capturing 0
        await cancelPaymentIntent(config, record.stripePaymentIntentId);
        const [updated] = await db
          .update(paymentRecords)
          .set({
            status: 'cancelled',
            capturedAmountCents: 0,
            updatedAt: new Date(),
          })
          .where(eq(paymentRecords.id, record.id))
          .returning();
        return updated;
      }

      await capturePayment(
        config,
        record.stripePaymentIntentId,
        amountCents,
        `capture_${String(record.id)}`,
      );
      const [updated] = await db
        .update(paymentRecords)
        .set({
          status: 'captured',
          capturedAmountCents: amountCents,
          updatedAt: new Date(),
        })
        .where(eq(paymentRecords.id, record.id))
        .returning();

      return updated;
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

      // Lock the payment record for the duration of the refund so a concurrent
      // capture or refund can't read a stale captured/refunded amount and
      // double-spend.
      const updated = await db.transaction(async (tx) => {
        const lockedRows = await tx.execute<{
          id: number;
          status: string;
          stripe_payment_intent_id: string | null;
          captured_amount_cents: number | null;
          refunded_amount_cents: number;
          driver_id: string | null;
          currency: string;
          session_id: string | null;
        }>(sql`
          SELECT id, status, stripe_payment_intent_id, captured_amount_cents,
                 refunded_amount_cents, driver_id, currency, session_id
          FROM payment_records
          WHERE session_id = ${id}
          FOR UPDATE
        `);
        const locked = lockedRows[0];

        if (
          locked == null ||
          (locked.status !== 'captured' && locked.status !== 'partially_refunded')
        ) {
          await reply.status(400).send({
            error: 'No captured payment to refund',
            code: 'NO_CAPTURED_PAYMENT',
          });
          return null;
        }
        if (locked.stripe_payment_intent_id == null) {
          await reply.status(400).send({
            error: 'Payment intent missing',
            code: 'MISSING_PAYMENT_INTENT',
          });
          return null;
        }

        const captured = locked.captured_amount_cents ?? 0;
        const alreadyRefunded = locked.refunded_amount_cents;
        const remaining = captured - alreadyRefunded;
        const requestedAmount = body.amountCents ?? remaining;
        if (requestedAmount <= 0 || requestedAmount > remaining) {
          await reply.status(409).send({
            error: `Refund amount ${String(requestedAmount)} exceeds remaining refundable balance ${String(remaining)}`,
            code: 'REFUND_EXCEEDS_REMAINING',
          });
          return null;
        }

        const [station] = await tx
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
          .where(eq(chargingSessions.id, id));

        // Site access enforcement: operators with restricted site access
        // can only refund payments for sessions on their assigned sites.
        const siteIds = await getUserSiteIds(userId);
        if (siteIds != null && station?.siteId != null && !siteIds.includes(station.siteId)) {
          await reply.status(404).send({
            error: 'Payment not found',
            code: 'PAYMENT_NOT_FOUND',
          });
          return null;
        }

        const config = await getStripeConfig(station?.siteId ?? null);
        if (config == null) {
          await reply.status(400).send({
            error: 'No Stripe configuration available',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return null;
        }

        // Idempotency key derived from intent + already-refunded delta + new
        // amount. Survives client retries (timeouts, network blips) by
        // producing the same key for the same logical operation, while still
        // allowing legitimate sequential partial refunds (alreadyRefunded
        // changes between calls so the next partial refund gets a different
        // key). Stripe holds idempotency keys for 24h.
        const refundRequestId = `${String(locked.id)}_${String(alreadyRefunded)}_${String(requestedAmount)}`;
        await createRefund(
          config,
          locked.stripe_payment_intent_id,
          requestedAmount,
          refundRequestId,
        );

        const refundedTotal = alreadyRefunded + requestedAmount;
        const isFullRefund = refundedTotal >= captured;

        const [row] = await tx
          .update(paymentRecords)
          .set({
            status: isFullRefund ? 'refunded' : 'partially_refunded',
            refundedAmountCents: refundedTotal,
            lastActorUserId: userId,
            lastActionReason: body.reason ?? (isFullRefund ? 'Full refund' : 'Partial refund'),
            updatedAt: new Date(),
          })
          .where(eq(paymentRecords.id, locked.id))
          .returning();
        return row;
      });

      if (updated == null) return;

      // Driver notification: payment refunded. Fire-and-forget so a slow
      // SMTP/Twilio call doesn't delay the refund response, but capture the
      // promise rejection (the surrounding try/catch only saw synchronous
      // throws and silently dropped async failures, which masked SMTP misconfig).
      if (updated.driverId != null) {
        dispatchDriverNotification(
          client,
          'payment.Refunded',
          updated.driverId,
          {
            amountCents: body.amountCents ?? updated.capturedAmountCents ?? 0,
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

      const [record] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, id));

      if (record == null) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }
      if (record.stripePaymentIntentId == null) {
        await reply.status(409).send({
          error: 'Payment has no Stripe intent',
          code: 'PAYMENT_RECORD_NOT_RECOVERABLE',
        });
        return;
      }

      // Look up the session's final cost to know the target amount.
      const sessionId = record.sessionId;
      if (sessionId == null) {
        await reply.status(409).send({
          error: 'Payment is not linked to a session',
          code: 'PAYMENT_RECORD_NOT_RECOVERABLE',
        });
        return;
      }
      const [sessionRow] = await db.execute<{
        final_cost_cents: number | null;
        site_id: string | null;
      }>(sql`
        SELECT cs.final_cost_cents, cs2.site_id
        FROM charging_sessions cs
        JOIN charging_stations cs2 ON cs2.id = cs.station_id
        WHERE cs.id = ${sessionId}
      `);

      // Site access enforcement: operators with restricted site access can
      // only retry payments for sessions on their assigned sites.
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && sessionRow?.site_id != null && !siteIds.includes(sessionRow.site_id)) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      const finalCostCents = sessionRow?.final_cost_cents ?? 0;
      const captured = record.capturedAmountCents ?? 0;
      const shortfall = finalCostCents - captured;
      if (shortfall <= 0) {
        await reply.status(409).send({
          error: 'No shortfall to recover',
          code: 'PAYMENT_RECORD_NOT_RECOVERABLE',
        });
        return;
      }

      const config = await getStripeConfig(sessionRow?.site_id ?? null);
      if (config == null) {
        await reply.status(409).send({
          error: 'Stripe not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      let topUpId: string;
      try {
        const origIntent = await config.stripe.paymentIntents.retrieve(
          record.stripePaymentIntentId,
        );
        const customerId =
          typeof origIntent.customer === 'string'
            ? origIntent.customer
            : (origIntent.customer?.id ?? null);
        const pmId =
          typeof origIntent.payment_method === 'string'
            ? origIntent.payment_method
            : (origIntent.payment_method?.id ?? null);
        if (customerId == null || pmId == null) {
          throw new Error('Original PaymentIntent missing customer or payment_method');
        }
        const params: Record<string, unknown> = {
          amount: shortfall,
          currency: record.currency.toLowerCase(),
          customer: customerId,
          payment_method: pmId,
          confirm: true,
          off_session: true,
          capture_method: 'automatic',
          description: `Retry top-up for session ${sessionId}`,
        };
        if (origIntent.on_behalf_of != null) {
          params['on_behalf_of'] = origIntent.on_behalf_of;
          params['transfer_data'] = {
            destination:
              typeof origIntent.on_behalf_of === 'string'
                ? origIntent.on_behalf_of
                : origIntent.on_behalf_of.id,
          };
          // Carry the same platform-fee rate onto the top-up. Without this
          // the entire delta flows to the connected account and the platform
          // gets nothing on the overage portion of the session.
          if (
            origIntent.application_fee_amount != null &&
            origIntent.application_fee_amount > 0 &&
            origIntent.amount > 0
          ) {
            const feeRate = origIntent.application_fee_amount / origIntent.amount;
            params['application_fee_amount'] = Math.round(shortfall * feeRate);
          }
        }
        const topUp = await config.stripe.paymentIntents.create(
          params as unknown as Parameters<typeof config.stripe.paymentIntents.create>[0],
          { idempotencyKey: `topup_retry_${String(record.id)}_${String(captured)}` },
        );
        topUpId = topUp.id;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message.slice(0, 400) : 'Top-up failed';
        await reply.status(502).send({
          error: `Stripe rejected top-up: ${message}`,
          code: 'PAYMENT_TOP_UP_FAILED',
        });
        return;
      }

      const [updated] = await db
        .update(paymentRecords)
        .set({
          capturedAmountCents: finalCostCents,
          failureReason: null,
          lastActorUserId: userId,
          lastActionReason: `Operator retry top-up; recovered ${String(shortfall)}c via ${topUpId}`,
          updatedAt: new Date(),
        })
        .where(eq(paymentRecords.id, record.id))
        .returning();
      return updated;
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
          .orderBy(desc(paymentReconciliationRuns.createdAt))
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
      const { reconcilePayments } = await import('../services/payment-reconciliation.service.js');
      const result = await reconcilePayments(request.log);

      await db.insert(paymentReconciliationRuns).values({
        checkedCount: result.checked,
        matchedCount: result.matched,
        discrepancyCount: result.discrepancies.length,
        errorCount: result.errors.length,
        discrepancies: result.discrepancies,
        errors: result.errors.length > 0 ? result.errors : null,
      });

      return result;
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
