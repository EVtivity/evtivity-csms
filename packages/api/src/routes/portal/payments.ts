// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  continueDriverMethodSetup,
  listDriverMethods,
  removeDriverMethod,
  saveDriverMethod,
  setDefaultDriverMethod,
  startDriverMethodSetup,
  submitDriverMethodSetup,
} from '@evtivity/payments';
import type { BrowserContext, DriverPaymentMethod, MethodSetupSession } from '@evtivity/payments';
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
import { paymentContext } from '../../lib/payments.js';
import { methodSetupSessionSchema } from '../../lib/payment-provider-schemas.js';
import {
  sendSetupStepOutcome,
  setupDetailsBody,
  portalSetupSubmitBody,
  setupStepResponses,
} from '../../lib/method-setup-step.js';
import { config as apiConfig } from '../../lib/config.js';
import { getMobileAppConfig } from '@evtivity/database';
import {
  appReturnUrlError,
  appShopperContext,
  originMismatchError,
  shopperBrowserContext,
} from '../../lib/shopper-browser.js';

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
    provider: z.string().describe('Payment provider the card is added with (stripe, simulated)'),
    clientSecret: z
      .string()
      .nullable()
      .describe('Stripe SetupIntent client_secret used by Stripe.js to confirm the card'),
    customerId: z.string().max(255).describe('Provider customer ID associated with the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable key for the configured Stripe account'),
    session: methodSetupSessionSchema,
  })
  .passthrough();

const ephemeralKeyResponse = z
  .object({
    provider: z.string().describe('Payment provider the card is added with (stripe)'),
    ephemeralKey: z
      .string()
      .describe('Stripe ephemeral key secret used by the native PaymentSheet'),
    customerId: z.string().max(255).describe('Stripe Customer ID associated with the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable key for the configured Stripe account'),
    setupIntentClientSecret: z
      .string()
      .nullable()
      .describe('Client secret of the card-only SetupIntent created with the key'),
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

// Provider identifiers (customer, method) never leave the server: the portal
// only needs the display fields, and those ids are exactly the inputs a
// cross-driver charge would need.
function toPublicPaymentMethod(row: DriverPaymentMethod): {
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

/** The Stripe fields of a setup session (other providers return their own shape). */
function stripeFields(session: MethodSetupSession): {
  clientSecret: string | null;
  publishableKey: string;
  ephemeralKey: string | null;
} {
  const s = session as { clientSecret?: unknown; publishableKey?: unknown; ephemeralKey?: unknown };
  return {
    clientSecret: typeof s.clientSecret === 'string' ? s.clientSecret : null,
    publishableKey: typeof s.publishableKey === 'string' ? s.publishableKey : '',
    ephemeralKey: typeof s.ephemeralKey === 'string' ? s.ephemeralKey : null,
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
      // Rows saved without card details are filled in from the provider once.
      const rows = await listDriverMethods(driverId, paymentContext(request.log));
      return rows.map(toPublicPaymentMethod);
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
          'Returns a short-lived, single-customer Stripe ephemeral key, the customer id, the publishable key and the client secret of a card-only SetupIntent, so the native Stripe PaymentSheet can add and manage the driver saved cards on-device. Lazily provisions the customer when missing. apiVersion is supplied by the mobile SDK via the stripeVersion query param. Returns 400 PAYMENT_PROVIDER_NOT_CONFIGURED when the active payment provider has no native sheet.',
        operationId: 'portalCreateEphemeralKey',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(ephemeralKeyQuery),
        response: {
          200: itemResponse(ephemeralKeyResponse),
          400: errorWith('Payment provider not configured', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stripeVersion } = request.query as z.infer<typeof ephemeralKeyQuery>;
      const result = await startDriverMethodSetup(
        { driverId, channel: 'native', nativeSdkVersion: stripeVersion },
        paymentContext(request.log),
      );
      if (result.status === 'driver_not_found') {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      const fields = result.status === 'started' ? stripeFields(result.session) : null;
      if (result.status !== 'started' || fields?.ephemeralKey == null) {
        await reply.status(400).send({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      return {
        provider: result.providerId,
        ephemeralKey: fields.ephemeralKey,
        customerId: result.customerId,
        publishableKey: fields.publishableKey,
        setupIntentClientSecret: fields.clientSecret,
      };
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
          'Lazily creates the payment provider customer for the driver if one does not already exist (a customer the provider no longer knows is replaced once), then starts the card setup with the active provider (Stripe: a card-only SetupIntent) so the portal can collect a card without an immediate charge. Returns session, the setup session of the active provider for its card UI, plus the Stripe client secret and publishable key as top-level fields.',
        operationId: 'portalCreateSetupIntent',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(setupIntentResponse),
          400: errorWith('Payment provider not configured', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const result = await startDriverMethodSetup(
        { driverId, channel: 'web' },
        paymentContext(request.log),
      );
      if (result.status === 'driver_not_found') {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      if (result.status === 'not_configured') {
        await reply.status(400).send({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      if (result.status === 'failed') {
        // The cause is logged by the service; the driver gets a generic
        // message that leaks no provider details.
        await reply.status(400).send({
          error: 'Payment setup failed',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const fields = stripeFields(result.session);
      return {
        provider: result.providerId,
        clientSecret: fields.clientSecret,
        customerId: result.customerId,
        publishableKey: fields.publishableKey,
        session: result.session,
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
        description:
          'Saves the method the client confirmed. The customer must be the one created for this driver by the setup, and the provider reads the method back and checks it is attached to that customer (403 otherwise); brand and last 4 digits come from the provider, never the client.',
        operationId: 'portalSavePaymentMethod',
        security: [{ bearerAuth: [] }],
        body: zodSchema(savePaymentMethodBody),
        response: {
          201: itemResponse(paymentMethodItem),
          400: errorWith('Payment provider not configured', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          403: errorResponse,
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;
      const result = await saveDriverMethod(
        {
          driverId,
          customerId: body.stripeCustomerId,
          methodId: body.stripePaymentMethodId,
          adoptCustomer: false,
        },
        paymentContext(request.log),
      );
      switch (result.status) {
        case 'saved':
          await reply.status(201).send(toPublicPaymentMethod(result.method));
          return;
        case 'driver_not_found':
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        case 'forbidden':
          await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
          return;
        case 'not_initialized':
          await reply.status(400).send({
            error: 'Payment setup not initialized',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'not_configured':
          await reply.status(400).send({
            error: 'Payment provider not configured',
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

  app.post(
    '/portal/payment-methods/setup/submit',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Submit a card collected by the payment provider card UI',
        description:
          "Saves the card the active provider's card UI collected after POST /v1/portal/payment-methods/setup-intent. The customer is the driver's own at that provider (never sent by the client); brand and last 4 digits come from the provider. Returns 201 with the saved method, or 200 with an action (3D Secure, test provider challenge) whose result goes to setup/details. A card that can ask for 3D Secure (Adyen) needs browser: the issuer returns the shopper to PORTAL_URL/payments/return?flow=method&provider=&attemptId=, and browser.origin must be the PORTAL_URL origin (else 400 VALIDATION_ERROR). The mobile app sends browser { platform: ios | android, returnUrl } instead: the provider channel follows the platform, and returnUrl (from the app's payment SDK) must lead back to an app build listed in the mobile.app.urlSchemes or mobile.app.androidPackageNames settings (else 400 VALIDATION_ERROR). A refused card is 400 PAYMENT_FAILED with details.reason. The same attemptId returns the same method.",
        operationId: 'portalSubmitPaymentMethodSetup',
        security: [{ bearerAuth: [] }],
        body: zodSchema(portalSetupSubmitBody),
        response: setupStepResponses(paymentMethodItem),
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof portalSetupSubmitBody>;
      let browser: BrowserContext | undefined;
      if (body.browser != null && 'platform' in body.browser) {
        // The mobile app: its payment SDK owns the return URL.
        const app = appShopperContext(body.browser, await getMobileAppConfig());
        if (app == null) {
          await reply.status(400).send(appReturnUrlError());
          return;
        }
        browser = app;
      } else if (body.browser != null) {
        // The 3DS return page posts the redirect result to setup/details with
        // the provider and attemptId from its query.
        const web = shopperBrowserContext(body.browser, apiConfig.PORTAL_URL, '/payments/return', {
          flow: 'method',
          provider: body.provider,
          attemptId: body.attemptId,
        });
        if (web == null) {
          await reply.status(400).send(originMismatchError(apiConfig.PORTAL_URL));
          return;
        }
        browser = web;
      }
      const outcome = await submitDriverMethodSetup(
        {
          driverId,
          providerId: body.provider,
          attemptId: body.attemptId,
          payload: body.payload,
          ...(browser != null ? { browser } : {}),
          adoptCustomer: false,
        },
        paymentContext(request.log),
      );
      await sendSetupStepOutcome(reply, outcome, toPublicPaymentMethod);
    },
  );

  app.post(
    '/portal/payment-methods/setup/details',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Continue a card setup after a client action',
        description:
          'Sends the result of the action setup/submit returned (3D Secure, test provider challenge) with the same attemptId. Returns 201 with the saved method, 200 with a further action, or 400 PAYMENT_FAILED when the card is refused.',
        operationId: 'portalContinuePaymentMethodSetup',
        security: [{ bearerAuth: [] }],
        body: zodSchema(setupDetailsBody),
        response: setupStepResponses(paymentMethodItem),
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof setupDetailsBody>;
      const outcome = await continueDriverMethodSetup(
        {
          driverId,
          providerId: body.provider,
          attemptId: body.attemptId,
          details: body.details,
        },
        paymentContext(request.log),
      );
      await sendSetupStepOutcome(reply, outcome, toPublicPaymentMethod);
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
          'Removes a saved payment method and detaches it at the payment provider. Returns 409 PAYMENT_METHOD_IN_USE if the method is still attached to an active or pre-authorized session, since deleting it would orphan the in-flight payment. When the default is removed, the oldest remaining method becomes the default.',
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
      const result = await removeDriverMethod(
        { driverId, methodRowId: pmId, blockWhenInUse: true },
        paymentContext(request.log),
      );
      if (result.status === 'not_found') {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      if (result.status === 'in_use') {
        await reply.status(409).send({
          error: 'Payment method is in use by an active charging session',
          code: 'PAYMENT_METHOD_IN_USE',
        });
        return;
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
      const updated = await setDefaultDriverMethod(driverId, pmId);
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
