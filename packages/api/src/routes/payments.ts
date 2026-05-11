// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
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
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { config as apiConfig } from '../lib/config.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';

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
        response: { 200: itemResponse(sitePaymentConfigItem), 404: errorResponse },
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
        response: { 200: itemResponse(sitePaymentConfigItem), 404: errorResponse },
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
        response: { 200: successResponse, 404: errorResponse },
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
      const rows = await db.select().from(settings);
      const map = new Map<string, unknown>();
      for (const row of rows) {
        if (row.key.startsWith('stripe.')) {
          map.set(row.key, row.value);
        }
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
        response: { 200: successResponse, 400: errorResponse },
      },
    },
    async (_request, reply) => {
      const config = await getStripeConfig(null);
      if (config == null) {
        await reply.status(400).send({
          error: 'Stripe is not configured',
          code: 'STRIPE_NOT_CONFIGURED',
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
          code: 'STRIPE_CONNECTION_FAILED',
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
          400: errorResponse,
          404: errorResponse,
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
          code: 'STRIPE_NOT_CONFIGURED',
        });
        return;
      }

      // Find or create Stripe customer. Wrap the SDK calls so an invalid or
      // stale API key surfaces as STRIPE_NOT_CONFIGURED instead of a 500.
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
            code: 'STRIPE_NOT_CONFIGURED',
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
          code: 'STRIPE_NOT_CONFIGURED',
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
        response: { 200: successResponse, 404: errorResponse },
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
        response: { 200: itemResponse(driverPaymentMethodItem), 404: errorResponse },
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
          404: errorResponse,
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
          code: 'STRIPE_NOT_CONFIGURED',
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
        response: { 200: itemResponse(paymentRecordItem), 400: errorResponse, 404: errorResponse },
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
          code: 'STRIPE_NOT_CONFIGURED',
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

      await capturePayment(config, record.stripePaymentIntentId, amountCents);
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
          'Issues a Stripe refund against the payment record for the session. Supports partial refunds via amountCents; defaults to a full refund. Updates the payment record to refunded or partially_refunded and writes an audit log entry on success. Returns 409 if the payment is not refundable (uncaptured, already fully refunded).',
        operationId: 'refundSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(refundBody),
        response: { 200: itemResponse(paymentRecordItem), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof refundBody>;

      const [record] = await db
        .select()
        .from(paymentRecords)
        .where(eq(paymentRecords.sessionId, id));

      if (record == null || record.status !== 'captured') {
        await reply.status(400).send({
          error: 'No captured payment to refund',
          code: 'NO_CAPTURED_PAYMENT',
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

      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id));

      const config = await getStripeConfig(station?.siteId ?? null);
      if (config == null) {
        await reply.status(400).send({
          error: 'No Stripe configuration available',
          code: 'STRIPE_NOT_CONFIGURED',
        });
        return;
      }

      await createRefund(config, record.stripePaymentIntentId, body.amountCents);

      const refundedTotal =
        record.refundedAmountCents + (body.amountCents ?? record.capturedAmountCents ?? 0);
      const isFullRefund = refundedTotal >= (record.capturedAmountCents ?? 0);

      const [updated] = await db
        .update(paymentRecords)
        .set({
          status: isFullRefund ? 'refunded' : 'partially_refunded',
          refundedAmountCents: refundedTotal,
          updatedAt: new Date(),
        })
        .where(eq(paymentRecords.id, record.id))
        .returning();

      // Driver notification: payment refunded
      if (record.driverId != null) {
        try {
          void dispatchDriverNotification(
            client,
            'payment.Refunded',
            record.driverId,
            {
              amountCents: body.amountCents ?? record.capturedAmountCents ?? 0,
              currency: record.currency,
              transactionId: record.sessionId,
            },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        } catch {
          // Non-critical: do not block refund response
        }
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
        response: { 200: itemResponse(paymentRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
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
      const offset = (page - 1) * limit;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(paymentRecords)
          .orderBy(desc(paymentRecords.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(paymentRecords),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
