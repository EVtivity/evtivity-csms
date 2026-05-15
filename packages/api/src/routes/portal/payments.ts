// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
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
  detachPaymentMethod,
  retrievePaymentMethod,
} from '../../services/stripe.service.js';
import { isSimulatedCustomer } from '@evtivity/lib';

const paymentMethodItem = z
  .object({
    id: z.string().describe('Driver payment method ID'),
    driverId: z.string().describe('Owning driver ID'),
    stripeCustomerId: z.string().max(255).describe('Stripe Customer ID'),
    stripePaymentMethodId: z.string().max(255).describe('Stripe PaymentMethod ID'),
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

const paymentMethodParams = z.object({
  pmId: z.coerce.number().int().min(1).describe('Payment method ID'),
});

const savePaymentMethodBody = z.object({
  stripePaymentMethodId: z.string().min(1),
  stripeCustomerId: z.string().min(1),
  cardBrand: z.string().max(20).optional(),
  cardLast4: z.string().max(4).optional(),
});

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
      const rows = await db
        .select()
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId));

      // Backfill cardBrand/cardLast4 from Stripe for legacy rows where the
      // frontend stored null (the SetupIntent.payment_method was a string ID,
      // not the expanded object). One-time per row, then never again.
      const needsBackfill = rows.filter(
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
      return rows;
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
          400: errorWith('Stripe not configured', [ERROR_CODES.STRIPE_NOT_CONFIGURED]),
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
          error: 'No Stripe configuration available',
          code: 'STRIPE_NOT_CONFIGURED',
        });
        return;
      }

      const [existingMethod] = await db
        .select({ stripeCustomerId: driverPaymentMethods.stripeCustomerId })
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId))
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
    '/portal/payment-methods',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Save a payment method after Stripe setup',
        operationId: 'portalSavePaymentMethod',
        security: [{ bearerAuth: [] }],
        body: zodSchema(savePaymentMethodBody),
        response: { 201: itemResponse(paymentMethodItem) },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;

      const existingMethods = await db
        .select({ id: driverPaymentMethods.id })
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId));

      const isDefault = existingMethods.length === 0;

      // Resolve cardBrand/cardLast4 server-side from Stripe. The client cannot
      // reliably send these because stripe.confirmCardSetup() returns
      // SetupIntent.payment_method as a string ID, not the expanded object.
      let cardBrand: string | null = body.cardBrand ?? null;
      let cardLast4: string | null = body.cardLast4 ?? null;
      if (!isSimulatedCustomer(body.stripeCustomerId)) {
        try {
          const stripeConfig = await getStripeConfig(null);
          if (stripeConfig != null) {
            const pm = await retrievePaymentMethod(stripeConfig, body.stripePaymentMethodId);
            cardBrand = pm.card?.brand ?? cardBrand;
            cardLast4 = pm.card?.last4 ?? cardLast4;
          }
        } catch (err: unknown) {
          request.log.warn(
            { err, paymentMethodId: body.stripePaymentMethodId },
            'Failed to fetch card details from Stripe; storing client-supplied values',
          );
        }
      }

      const [method] = await db
        .insert(driverPaymentMethods)
        .values({
          driverId,
          stripeCustomerId: body.stripeCustomerId,
          stripePaymentMethodId: body.stripePaymentMethodId,
          cardBrand,
          cardLast4,
          isDefault,
        })
        .returning();

      await reply.status(201).send(method);
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
      } catch {
        // Stripe not configured or payment method already detached
      }

      await db.delete(driverPaymentMethods).where(eq(driverPaymentMethods.id, pmId));

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

      await db
        .update(driverPaymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(driverPaymentMethods.driverId, driverId));

      const [updated] = await db
        .update(driverPaymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(driverPaymentMethods.id, pmId))
        .returning();

      return updated;
    },
  );
}
