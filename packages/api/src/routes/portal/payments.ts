// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { drivers, driverPaymentMethods } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  getStripeConfig,
  createSetupIntent,
  createCustomer,
  createEphemeralKey,
  detachPaymentMethod,
  retrievePaymentMethod,
} from '../../services/stripe.service.js';
import { isSimulatedCustomer } from '@evtivity/lib';

const paymentMethodItem = z
  .object({
    id: z.string().describe('Driver payment method ID'),
    driverId: z.string().describe('Owning driver ID'),
    cardBrand: z
      .string()
      .max(20)
      .nullable()
      .describe('Card network (visa, mastercard, amex, etc.)'),
    cardLast4: z.string().length(4).nullable().describe('Last 4 digits of the card'),
    isDefault: z.boolean().describe('Whether this is the default payment method'),
    createdAt: z.coerce.date().describe('Timestamp the payment method was added'),
    updatedAt: z.coerce.date().describe('Timestamp the payment method was last updated'),
  })
  .passthrough();

const setupIntentResponse = z
  .object({
    clientSecret: z
      .string()
      .nullable()
      .describe('Stripe SetupIntent client_secret used by Stripe.js to confirm the card'),
    customerId: z.string().max(255).describe('Stripe Customer ID associated with the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable key for the configured Stripe account'),
  })
  .passthrough();

const ephemeralKeyResponse = z
  .object({
    ephemeralKey: z
      .string()
      .describe('Stripe ephemeral key secret used by the native PaymentSheet'),
    customerId: z.string().max(255).describe('Stripe Customer ID associated with the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable key for the configured Stripe account'),
  })
  .passthrough();

const ephemeralKeyQuery = z.object({
  stripeVersion: z.string().min(1).describe('Stripe API version pinned by the mobile SDK'),
});

const paymentMethodParams = z.object({
  pmId: z.coerce.number().int().min(1).describe('Payment method ID'),
});

const savePaymentMethodBody = z.object({
  stripePaymentMethodId: z.string().min(1),
  stripeCustomerId: z.string().min(1),
  cardBrand: z.string().max(20).optional(),
  cardLast4: z.string().max(4).optional(),
});

// Strip Stripe-internal identifiers before returning to the driver. The portal
// UI only needs display fields; leaking the customer / payment-method IDs to
// the client is unnecessary attack surface, especially given those IDs are
// the inputs the previous cross-driver-charge bug abused.
function toPublicPaymentMethod(row: {
  id: number;
  driverId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): {
  id: number;
  driverId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: row.id,
    driverId: row.driverId,
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function portalPaymentRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/payment-methods',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'List saved payment methods',
        operationId: 'portalListPaymentMethods',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(paymentMethodItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      // Internal fields needed for backfill / Stripe lookups, not surfaced
      // to the driver in the response.
      const internalRows = await db
        .select()
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId))
        .orderBy(desc(driverPaymentMethods.createdAt), desc(driverPaymentMethods.id));

      // Backfill cardBrand/cardLast4 from Stripe for legacy rows where the
      // frontend stored null (the SetupIntent.payment_method was a string ID,
      // not the expanded object). One-time per row, then never again.
      const needsBackfill = internalRows.filter(
        (r) => r.cardLast4 == null && !isSimulatedCustomer(r.stripeCustomerId),
      );
      if (needsBackfill.length > 0) {
        const stripeConfig = await getStripeConfig(null);
        if (stripeConfig != null) {
          // Backfill in parallel — each row is a separate Stripe round-trip
          // and they don't depend on each other. Sequential awaits added up
          // to (rows * ~200ms) of GET-list latency for legacy drivers.
          await Promise.all(
            needsBackfill.map(async (row) => {
              try {
                const pm = await retrievePaymentMethod(stripeConfig, row.stripePaymentMethodId);
                const brand = pm.card?.brand ?? null;
                const last4 = pm.card?.last4 ?? null;
                if (brand != null || last4 != null) {
                  await db
                    .update(driverPaymentMethods)
                    .set({ cardBrand: brand, cardLast4: last4, updatedAt: new Date() })
                    .where(eq(driverPaymentMethods.id, row.id));
                  row.cardBrand = brand;
                  row.cardLast4 = last4;
                }
              } catch (err: unknown) {
                request.log.warn(
                  { err, paymentMethodId: row.stripePaymentMethodId },
                  'Failed to backfill card details from Stripe',
                );
              }
            }),
          );
        }
      }
      // Strip Stripe-internal identifiers (customer / payment method IDs)
      // before returning. The driver only needs the display fields; leaking
      // Stripe IDs to the portal client is needless attack surface.
      return internalRows.map((row) => ({
        id: row.id,
        driverId: row.driverId,
        cardBrand: row.cardBrand,
        cardLast4: row.cardLast4,
        isDefault: row.isDefault,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },
  );

  app.post(
    '/portal/payment-methods/ephemeral-key',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Create a Stripe ephemeral key for the native PaymentSheet',
        description:
          'Returns a short-lived, single-customer Stripe ephemeral key plus the customer id and publishable key so the native Stripe PaymentSheet can read and manage the driver saved cards on-device. Lazily provisions the Stripe customer when missing. apiVersion is supplied by the mobile SDK via the stripeVersion query param.',
        operationId: 'portalCreateEphemeralKey',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(ephemeralKeyQuery),
        response: {
          200: itemResponse(ephemeralKeyResponse),
          400: errorWith('Stripe not configured', [ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stripeVersion } = request.query as z.infer<typeof ephemeralKeyQuery>;

      const [driver] = await db
        .select({
          id: drivers.id,
          email: drivers.email,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          stripeCustomerId: drivers.stripeCustomerId,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const config = await getStripeConfig(null);
      if (config == null) {
        await reply.status(400).send({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      try {
        let customerId = driver.stripeCustomerId;
        if (customerId == null) {
          const customer = await createCustomer(
            config,
            driver.email ?? '',
            `${driver.firstName} ${driver.lastName}`,
          );
          customerId = customer.id;
          await db
            .update(drivers)
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(eq(drivers.id, driverId));
        }

        // Simulated customers bypass Stripe entirely (mirrors the pre-auth path).
        if (isSimulatedCustomer(customerId)) {
          return {
            ephemeralKey: `ek_sim_${customerId}`,
            customerId,
            publishableKey: config.publishableKey,
          };
        }

        const key = await createEphemeralKey(config, customerId, stripeVersion);
        return {
          ephemeralKey: key.secret ?? '',
          customerId,
          publishableKey: config.publishableKey,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        request.log.warn({ err: message }, 'Stripe ephemeral-key failed');
        await reply.status(400).send({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
    },
  );

  app.post(
    '/portal/payment-methods/setup-intent',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Create a Stripe SetupIntent for adding a payment method',
        description:
          'Lazily creates a Stripe customer for the driver if one does not already exist, then creates a SetupIntent so the portal can collect a card via Stripe Elements without an immediate charge. Returns the client secret and the Stripe publishable key needed to initialize Stripe.js.',
        operationId: 'portalCreateSetupIntent',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(setupIntentResponse),
          400: errorWith('Stripe not configured', [ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [driver] = await db
        .select({
          id: drivers.id,
          email: drivers.email,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          stripeCustomerId: drivers.stripeCustomerId,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const config = await getStripeConfig(null);
      if (config == null) {
        await reply.status(400).send({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      // Capture into locals so closures below don't need non-null assertions.
      const resolvedConfig = config;
      const resolvedDriver = driver;

      // Returns true if the error looks like a Stripe "customer does not exist
      // in this account" rejection. Triggers when the seed/legacy customer ID
      // was created against a different Stripe key, or the customer was
      // deleted in the Stripe dashboard. The recovery path mints a fresh
      // customer and updates the persisted ID.
      function isUnknownCustomerError(e: unknown): boolean {
        const m = e instanceof Error ? e.message : String(e);
        return /no such customer/i.test(m) || /resource_missing/i.test(m);
      }

      async function provisionCustomer(): Promise<string> {
        const customer = await createCustomer(
          resolvedConfig,
          resolvedDriver.email ?? '',
          `${resolvedDriver.firstName} ${resolvedDriver.lastName}`,
        );
        await db
          .update(drivers)
          .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
          .where(eq(drivers.id, driverId));
        return customer.id;
      }

      try {
        let customerId: string;
        if (driver.stripeCustomerId != null) {
          customerId = driver.stripeCustomerId;
        } else {
          // Fall back to a customer ID from an existing PM row to handle the
          // legacy case where a driver onboarded before drivers.stripeCustomerId
          // existed. Persist it so future setup-intent calls have it directly.
          const [existingMethod] = await db
            .select({ stripeCustomerId: driverPaymentMethods.stripeCustomerId })
            .from(driverPaymentMethods)
            .where(eq(driverPaymentMethods.driverId, driverId))
            .limit(1);
          if (existingMethod != null) {
            customerId = existingMethod.stripeCustomerId;
            await db
              .update(drivers)
              .set({ stripeCustomerId: customerId, updatedAt: new Date() })
              .where(eq(drivers.id, driverId));
          } else {
            customerId = await provisionCustomer();
          }
        }

        let setupIntent;
        try {
          setupIntent = await createSetupIntent(config, customerId);
        } catch (err: unknown) {
          if (!isUnknownCustomerError(err)) throw err;
          // Stale customer reference. Mint a new one and retry once. This
          // self-heals dev seeds that point at customers created under a
          // different Stripe test account and accounts whose customer was
          // deleted from the Stripe dashboard.
          request.log.warn(
            { err, oldCustomerId: customerId, driverId },
            'Stripe rejected stored customerId; provisioning a fresh customer',
          );
          customerId = await provisionCustomer();
          setupIntent = await createSetupIntent(config, customerId);
        }

        if (setupIntent.client_secret == null || setupIntent.client_secret === '') {
          await reply.status(400).send({
            error: 'Payment setup failed',
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
        const message = err instanceof Error ? err.message : 'unknown error';
        // Log the full error server-side; surface a generic message to the
        // client so we do not leak provider names or upstream API behavior.
        request.log.warn({ err: message }, 'Stripe setup-intent failed');
        await reply.status(400).send({
          error: 'Payment setup failed',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
    },
  );

  app.post(
    '/portal/payment-methods',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Save a payment method after Stripe setup',
        operationId: 'portalSavePaymentMethod',
        security: [{ bearerAuth: [] }],
        body: zodSchema(savePaymentMethodBody),
        response: {
          201: itemResponse(paymentMethodItem),
          400: errorWith('Stripe not configured', [ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED]),
          403: errorResponse,
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;

      // Bind the saved PM to the Stripe customer we created for this driver
      // in /setup-intent. Without this, a driver could submit another driver's
      // (stripeCustomerId, stripePaymentMethodId) pair — the pre-auth code in
      // event-projections.ts then reads `stripe_customer_id` + `stripe_payment_method_id`
      // directly from the poisoned row and charges the victim's card.
      const [driver] = await db
        .select({ stripeCustomerId: drivers.stripeCustomerId })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      let authoritativeCustomerId = driver.stripeCustomerId;
      if (authoritativeCustomerId == null) {
        // Legacy backfill: if a driver has prior PMs but no drivers.stripeCustomerId
        // (saved before the column existed), pin the first PM's customer ID.
        const [existing] = await db
          .select({ stripeCustomerId: driverPaymentMethods.stripeCustomerId })
          .from(driverPaymentMethods)
          .where(eq(driverPaymentMethods.driverId, driverId))
          .limit(1);
        if (existing != null) {
          authoritativeCustomerId = existing.stripeCustomerId;
          await db
            .update(drivers)
            .set({ stripeCustomerId: authoritativeCustomerId, updatedAt: new Date() })
            .where(eq(drivers.id, driverId));
        }
      }

      if (authoritativeCustomerId == null) {
        // No prior customer and no setup-intent run. Refuse — the client must
        // initialize payment setup before saving a method. Error text stays
        // generic so it does not leak Stripe internals or endpoint names.
        await reply.status(400).send({
          error: 'Payment setup not initialized',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }

      if (body.stripeCustomerId !== authoritativeCustomerId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const existingMethods = await db
        .select({ id: driverPaymentMethods.id })
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId));

      const isDefault = existingMethods.length === 0;

      // Resolve cardBrand/cardLast4 server-side from Stripe. The client cannot
      // reliably send these because stripe.confirmCardSetup() returns
      // SetupIntent.payment_method as a string ID, not the expanded object.
      // The retrievePaymentMethod call also doubles as the second-layer check
      // that the PM is actually attached to this driver's Stripe customer.
      let cardBrand: string | null = body.cardBrand ?? null;
      let cardLast4: string | null = body.cardLast4 ?? null;
      if (!isSimulatedCustomer(authoritativeCustomerId)) {
        try {
          const stripeConfig = await getStripeConfig(null);
          if (stripeConfig != null) {
            const pm = await retrievePaymentMethod(stripeConfig, body.stripePaymentMethodId);
            const attachedCustomer =
              typeof pm.customer === 'string' ? pm.customer : pm.customer?.id;
            if (attachedCustomer !== authoritativeCustomerId) {
              await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
              return;
            }
            cardBrand = pm.card?.brand ?? cardBrand;
            cardLast4 = pm.card?.last4 ?? cardLast4;
          }
        } catch (err: unknown) {
          request.log.warn(
            { err, paymentMethodId: body.stripePaymentMethodId },
            'Failed to fetch card details from Stripe; refusing save without verification',
          );
          await reply.status(400).send({
            error: 'Could not verify payment method',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        }
      }

      const [method] = await db
        .insert(driverPaymentMethods)
        .values({
          driverId,
          stripeCustomerId: authoritativeCustomerId,
          stripePaymentMethodId: body.stripePaymentMethodId,
          cardBrand,
          cardLast4,
          isDefault,
        })
        .returning();

      if (method == null) {
        throw new Error('Failed to save payment method');
      }
      await reply.status(201).send(toPublicPaymentMethod(method));
    },
  );

  app.delete(
    '/portal/payment-methods/:pmId',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Delete a saved payment method',
        description:
          'Removes a saved payment method. Returns 409 PAYMENT_METHOD_IN_USE if the method is still attached to an active or pre-authorized session, since deleting it would orphan the in-flight Stripe PaymentIntent.',
        operationId: 'portalDeletePaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: successResponse,
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { pmId } = request.params as z.infer<typeof paymentMethodParams>;

      const [method] = await db
        .select()
        .from(driverPaymentMethods)
        .where(and(eq(driverPaymentMethods.id, pmId), eq(driverPaymentMethods.driverId, driverId)));

      if (method == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }

      // Block delete when THIS specific PM is tied to an active or
      // pre-authorized session. Match on stripe_payment_method_id (not
      // stripe_customer_id) because a single Stripe customer can have
      // multiple cards saved -- blocking on customer match would prevent
      // deleting an unrelated card while another one had an in-flight
      // pre-auth.
      const inUse = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM payment_records pr
        JOIN charging_sessions cs ON cs.id = pr.session_id
        WHERE pr.driver_id = ${driverId}
          AND pr.stripe_payment_method_id = ${method.stripePaymentMethodId}
          AND pr.status IN ('pending', 'pre_authorized')
          AND cs.status = 'active'
      `);
      if ((inUse[0]?.count ?? 0) > 0) {
        await reply.status(409).send({
          error: 'Payment method is in use by an active charging session',
          code: 'PAYMENT_METHOD_IN_USE',
        });
        return;
      }

      try {
        const config = await getStripeConfig(null);
        if (config != null) {
          await detachPaymentMethod(config, method.stripePaymentMethodId);
        }
      } catch (err) {
        // Best-effort: a missing Stripe config or already-detached method is
        // expected; transient Stripe errors leave an orphaned PaymentMethod
        // we don't want to retry inline. Log so operators can clean up via
        // Stripe dashboard.
        request.log.warn(
          { err, pmId, stripePaymentMethodId: method.stripePaymentMethodId },
          'Failed to detach payment method from Stripe; deleting local row anyway',
        );
      }

      const wasDefault = method.isDefault;
      await db.delete(driverPaymentMethods).where(eq(driverPaymentMethods.id, pmId));

      // If we just removed the default, promote another PM so the next charge
      // can still resolve a default. Without this, a driver with 2 cards who
      // deletes their default ends up with no default; the pre-auth gate then
      // dispatches MissingPaymentMethod for a driver who clearly intends to
      // keep paying with the remaining card.
      if (wasDefault) {
        const [next] = await db
          .select({ id: driverPaymentMethods.id })
          .from(driverPaymentMethods)
          .where(eq(driverPaymentMethods.driverId, driverId))
          .orderBy(asc(driverPaymentMethods.createdAt))
          .limit(1);
        if (next != null) {
          await db
            .update(driverPaymentMethods)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(driverPaymentMethods.id, next.id));
        }
      }

      return { success: true };
    },
  );

  app.patch(
    '/portal/payment-methods/:pmId/default',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Set a payment method as the default',
        operationId: 'portalSetDefaultPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: itemResponse(paymentMethodItem),
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { pmId } = request.params as z.infer<typeof paymentMethodParams>;

      const [method] = await db
        .select({ id: driverPaymentMethods.id })
        .from(driverPaymentMethods)
        .where(and(eq(driverPaymentMethods.id, pmId), eq(driverPaymentMethods.driverId, driverId)));

      if (method == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }

      // Single atomic UPDATE so two concurrent set-default calls cannot both
      // win. With two separate statements, racing requests can interleave
      // their false-then-true sequence and leave multiple methods with
      // is_default=true. CASE inside one UPDATE locks all of the driver's
      // rows together and the last-committed transaction wins entirely.
      await db
        .update(driverPaymentMethods)
        .set({
          isDefault: sql`(${driverPaymentMethods.id} = ${pmId})`,
          updatedAt: new Date(),
        })
        .where(eq(driverPaymentMethods.driverId, driverId));

      const [updated] = await db
        .select()
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.id, pmId));

      if (updated == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      return toPublicPaymentMethod(updated);
    },
  );
}
