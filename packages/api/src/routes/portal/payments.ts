// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { drivers, driverPaymentMethods } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  itemResponse,
  arrayResponse,
} from '../../lib/response-schemas.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  getStripeConfig,
  createSetupIntent,
  createCustomer,
  detachPaymentMethod,
} from '../../services/stripe.service.js';

const paymentMethodItem = z
  .object({
    id: z.string(),
    driverId: z.string(),
    stripeCustomerId: z.string(),
    stripePaymentMethodId: z.string(),
    cardBrand: z.string().nullable(),
    cardLast4: z.string().nullable(),
    isDefault: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const setupIntentResponse = z
  .object({
    clientSecret: z.string().nullable(),
    customerId: z.string(),
    publishableKey: z.string(),
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
      return db
        .select()
        .from(driverPaymentMethods)
        .where(eq(driverPaymentMethods.driverId, driverId));
    },
  );

  app.post(
    '/portal/payment-methods/setup-intent',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Create a Stripe SetupIntent for adding a payment method',
        operationId: 'portalCreateSetupIntent',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(setupIntentResponse),
          400: errorResponse,
          404: errorResponse,
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
      return {
        clientSecret: setupIntent.client_secret,
        customerId,
        publishableKey: config.publishableKey,
      };
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

      const [method] = await db
        .insert(driverPaymentMethods)
        .values({
          driverId,
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
    '/portal/payment-methods/:pmId',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Delete a saved payment method',
        operationId: 'portalDeletePaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: { 200: successResponse, 404: errorResponse },
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
        response: { 200: itemResponse(paymentMethodItem), 404: errorResponse },
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
