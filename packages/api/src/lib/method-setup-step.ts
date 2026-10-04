// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { DriverPaymentMethod, SetupStepOutcome } from '@evtivity/payments';
import { errorWith, itemResponse } from './response-schemas.js';
import { ERROR_CODES } from './error-codes.generated.js';
import { appShopperBody, shopperBrowserBody } from './shopper-browser.js';

/**
 * The generic card setup steps shared by the portal
 * (`/portal/payment-methods/setup/*`) and the operator
 * (`/drivers/:id/payment-methods/setup/*`) routes (plan P5 section 5): body
 * schemas, responses, and the mapping of a SetupStepOutcome to the reply.
 */

const providerField = z
  .string()
  .min(1)
  .describe('Provider of the setup session the client ran its card UI for (session.provider)');

const attemptIdField = z
  .string()
  .uuid()
  .describe(
    'UUID the client generates when the card form opens; the same id makes a retried step idempotent',
  );

export const setupSubmitBody = z.object({
  provider: providerField,
  attemptId: attemptIdField,
  payload: z
    .unknown()
    .describe(
      "The card the provider's card UI collected. Stripe: { paymentMethodId } of the confirmed SetupIntent. Test provider: { testCard }. Adyen: the Card component state.data plus the setup session currency ({ paymentMethod, browserInfo?, currency }). Card numbers are never accepted, except the test provider's listed test cards.",
    ),
  browser: shopperBrowserBody
    .optional()
    .describe(
      'The browser the card UI runs in, for a 3D Secure step (required by Adyen). The issuer returns the shopper to <app URL>/payments/return?flow=method&provider=&attemptId= (the dashboard adds driverId), built by the server',
    ),
});

/**
 * The driver's setup/submit: the portal page sends its origin, the mobile app
 * its platform and the return URL of its payment SDK (plan P10 Part E).
 */
export const portalSetupSubmitBody = setupSubmitBody.extend({
  browser: z
    .union([shopperBrowserBody, appShopperBody])
    .optional()
    .describe(
      'Where the card UI runs, for a 3D Secure step (required by Adyen). Portal: { origin, info? }; the issuer returns the shopper to PORTAL_URL/payments/return?flow=method&provider=&attemptId=, built by the server. Mobile app: { platform, returnUrl, info? }; returnUrl must lead back to an app build listed in the mobile.app.* settings',
    ),
});

export const setupDetailsBody = z.object({
  provider: providerField,
  attemptId: attemptIdField,
  details: z
    .unknown()
    .describe(
      'Result of the client action (3D Secure). Adyen: the onAdditionalDetails state.data, or { details: { redirectResult } } from the return page. Test provider: { methodId, outcome: approve | fail } of its challenge.',
    ),
});

const actionRequiredResponse = z
  .object({
    status: z.literal('action_required').describe('The client must complete an action'),
    action: z
      .object({
        provider: z.string().describe('Provider whose client UI handles the action'),
        data: z.unknown().describe('Provider action data (3D Secure, test provider challenge)'),
      })
      .passthrough()
      .describe('Action for the card UI; post its result to setup/details'),
  })
  .passthrough()
  .describe('The card needs a client action before it is saved');

function savedResponse(methodItem: ZodTypeAny): ZodTypeAny {
  return z
    .object({
      status: z.literal('saved').describe('The card is saved'),
      method: methodItem,
    })
    .passthrough()
    .describe('The saved card');
}

/** Response schemas of a setup step route, with the route's payment method item. */
export function setupStepResponses(methodItem: ZodTypeAny): Record<number, unknown> {
  return {
    200: itemResponse(actionRequiredResponse),
    201: itemResponse(savedResponse(methodItem)),
    400: errorWith(
      'Card refused, invalid payload or browser origin, or no matching active provider',
      [
        ERROR_CODES.PAYMENT_FAILED,
        ERROR_CODES.VALIDATION_ERROR,
        ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
      ],
    ),
    403: errorWith('Card of another customer', [ERROR_CODES.FORBIDDEN]),
    404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
  };
}

/** Sends a setup step outcome; `toItem` shapes the saved row for the caller (portal hides provider ids). */
export async function sendSetupStepOutcome(
  reply: FastifyReply,
  outcome: SetupStepOutcome,
  toItem: (method: DriverPaymentMethod) => unknown,
): Promise<void> {
  switch (outcome.status) {
    case 'saved':
      await reply.status(201).send({ status: 'saved', method: toItem(outcome.method) });
      return;
    case 'action_required':
      await reply.status(200).send({ status: 'action_required', action: outcome.action });
      return;
    case 'refused':
      await reply.status(400).send({
        error: 'The card was refused',
        code: ERROR_CODES.PAYMENT_FAILED,
        details: { reason: outcome.reason },
      });
      return;
    case 'invalid':
      await reply.status(400).send({ error: outcome.reason, code: ERROR_CODES.VALIDATION_ERROR });
      return;
    case 'not_configured':
      await reply.status(400).send({
        error: 'Payment provider not configured',
        code: ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
      });
      return;
    case 'provider_mismatch':
      await reply.status(400).send({
        error: 'The card setup was started with another payment provider; start it again',
        code: ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
      });
      return;
    case 'not_initialized':
      await reply.status(400).send({
        error: 'Payment setup not initialized',
        code: ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
      });
      return;
    case 'forbidden':
      await reply.status(403).send({ error: 'Forbidden', code: ERROR_CODES.FORBIDDEN });
      return;
    case 'driver_not_found':
      await reply
        .status(404)
        .send({ error: 'Driver not found', code: ERROR_CODES.DRIVER_NOT_FOUND });
      return;
  }
}
