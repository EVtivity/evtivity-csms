// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ingestPaymentWebhook,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '@evtivity/payments';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paymentContext } from '../lib/payments.js';

const webhookResponse = z
  .object({ received: z.literal(true).describe('Acknowledgement that the webhook was processed') })
  .passthrough();

function headerMap(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(',');
  }
  return out;
}

export function webhookRoutes(app: FastifyInstance): void {
  // Raw body for the signature check. Scoped to this plugin, so other routes
  // keep JSON parsing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    '/webhooks/stripe',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Handle Stripe webhook events',
        description:
          'Verifies the stripe-signature header with the signing secret from Settings > Payment > Stripe (stripe.webhookSecretEnc), records each event id once (a replay is acknowledged and skipped), then applies payment_intent.payment_failed (only to pending or pre-authorized payments), charge.refunded (never lowering the refunded total) and logs charge.dispute.created.',
        operationId: 'handleStripeWebhook',
        security: [],
        response: {
          200: itemResponse(webhookResponse),
          400: errorWith('Validation error', [
            ERROR_CODES.VALIDATION_ERROR,
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
      try {
        await ingestPaymentWebhook(
          'stripe',
          request.body as string,
          headerMap(request.headers),
          paymentContext(request.log),
        );
      } catch (err) {
        if (err instanceof WebhookNotConfiguredError) {
          request.log.error(
            'Stripe webhook signing secret is not configured (stripe.webhookSecretEnc)',
          );
          await reply
            .status(500)
            .send({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
          return;
        }
        if (err instanceof WebhookSignatureError) {
          request.log.warn({ error: err.message }, 'Webhook signature verification failed');
          if (err.reason === 'missing') {
            await reply.status(400).send({
              error: 'Missing stripe-signature header',
              code: 'WEBHOOK_SIGNATURE_MISSING',
            });
          } else {
            await reply
              .status(400)
              .send({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
          }
          return;
        }
        throw err;
      }
      await reply.status(200).send({ received: true });
    },
  );
}
