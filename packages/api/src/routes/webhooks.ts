// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  dispatchPaymentWebhookNotices,
  ingestPaymentWebhook,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '@evtivity/payments';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paymentContext } from '../lib/payments.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { zodSchema } from '../lib/zod-schema.js';

const stripeAck = itemResponse(
  z
    .object({
      received: z.literal(true).describe('Acknowledgement that the webhook was processed'),
    })
    .passthrough(),
);

const adyenAck = zodSchema(
  z.string().describe('The text/plain acknowledgement [accepted] that Adyen expects'),
);

interface WebhookRouteDoc {
  providerId: 'stripe' | 'adyen';
  summary: string;
  description: string;
  operationId: string;
  ack: Record<string, unknown>;
}

const STRIPE_DOC: WebhookRouteDoc = {
  providerId: 'stripe',
  summary: 'Handle Stripe webhook events',
  description:
    'Receives the events of both EVtivity endpoints in Stripe: the platform endpoint (signed with stripe.webhookSecretEnc) and the Connect endpoint (signed with stripe.connectWebhookSecretEnc). Verifies the stripe-signature header with either secret, records each event id once (a replay is acknowledged and skipped), then applies payment_intent.payment_failed (only to pending or pre-authorized payments), charge.refunded (never lowering the refunded total), logs charge.dispute.created and passes account.updated to the site payout accounts. Answers {"received":true}.',
  operationId: 'handleStripeWebhook',
  ack: stripeAck,
};

const ADYEN_DOC: WebhookRouteDoc = {
  providerId: 'adyen',
  summary: 'Handle Adyen webhook events',
  description:
    'Receives Adyen standard webhooks (JSON). Checks the Basic auth credentials (adyen.webhookUsername, adyen.webhookPasswordEnc; 401 when missing or wrong), the HMAC signature of every notification item (adyen.hmacKeyEnc, or adyen.hmacKeyPreviousEnc during a key rotation), the merchant account and the live flag, records each event once (a replay is acknowledged and skipped) and answers the text [accepted].',
  operationId: 'handleAdyenWebhook',
  ack: adyenAck,
};

function headerMap(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(',');
  }
  return out;
}

/**
 * One route per provider at /webhooks/payments/<provider>, all through
 * ingestPaymentWebhook. A failed verification answers 4xx; any other error
 * reaches the global 500 handler so the provider retries (P9).
 */
function registerPaymentWebhookRoute(app: FastifyInstance, doc: WebhookRouteDoc): void {
  app.post(
    `/webhooks/payments/${doc.providerId}`,
    {
      schema: {
        tags: ['Webhooks'],
        summary: doc.summary,
        description: doc.description,
        operationId: doc.operationId,
        security: [],
        response: {
          200: doc.ack,
          400: errorWith('Validation error', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.WEBHOOK_SIGNATURE_MISSING,
            ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
          ]),
          401: errorWith('Webhook credentials missing or wrong', [
            ERROR_CODES.WEBHOOK_SIGNATURE_MISSING,
            ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
          ]),
          500: errorWith('Internal server error', [
            ERROR_CODES.INTERNAL_ERROR,
            ERROR_CODES.WEBHOOK_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (request, reply) => {
      let result;
      try {
        result = await ingestPaymentWebhook(
          doc.providerId,
          request.body as string,
          headerMap(request.headers),
          paymentContext(request.log),
        );
      } catch (err) {
        if (err instanceof WebhookNotConfiguredError) {
          request.log.error(
            { provider: doc.providerId },
            'Payment webhook secret or credentials are not configured',
          );
          await reply
            .status(500)
            .send({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
          return;
        }
        if (err instanceof WebhookSignatureError) {
          request.log.warn(
            {
              provider: doc.providerId,
              error: err.message,
              ...(err.unverified != null ? { unverified: err.unverified } : {}),
            },
            'Payment webhook verification failed',
          );
          const status = err.kind === 'auth' ? 401 : 400;
          if (err.reason === 'missing') {
            await reply.status(status).send({
              error: 'Missing webhook signature or credentials',
              code: 'WEBHOOK_SIGNATURE_MISSING',
            });
          } else {
            await reply
              .status(status)
              .send({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
          }
          return;
        }
        throw err;
      }
      // Driver notifications and the operator UI refresh for what the events
      // changed (fail-open, never delays the acknowledgement on an error).
      if (result.notices.length > 0) {
        await dispatchPaymentWebhookNotices(result.notices, {
          templatesDirs: ALL_TEMPLATES_DIRS,
          pubsub: getPubSub(),
          logger: request.log,
        });
      }
      // Every provider acknowledges with 200 (the only success the route
      // documents) and its own body. A string body with an explicit content
      // type is sent as is, without the response serializer.
      await reply.status(200).type(result.ack.contentType).send(result.ack.body);
    },
  );
}

export function webhookRoutes(app: FastifyInstance): void {
  // Raw body for the signature check. Scoped to this plugin, so other routes
  // keep JSON parsing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  registerPaymentWebhookRoute(app, STRIPE_DOC);
  registerPaymentWebhookRoute(app, ADYEN_DOC);
}
