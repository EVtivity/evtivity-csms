// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TerminalProviderError, TERMINAL_MAX_WEBHOOK_BYTES } from '@evtivity/payment-terminals';
import { handleTerminalResults } from '@evtivity/services/payment-terminal-flow';
import {
  dispatchPaymentWebhookNotices,
  ingestPaymentWebhook,
  ingestTerminalWebhook,
  paymentWebhookActor,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '@evtivity/payments';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paymentContext } from '../lib/payments.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { zodSchema } from '../lib/zod-schema.js';
import { config as apiConfig } from '../lib/config.js';

const stripeAck = itemResponse(
  z
    .object({
      received: z.literal(true).describe('Acknowledgement that the webhook was processed'),
    })
    .loose(),
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
          paymentContext(request.log, paymentWebhookActor(doc.providerId)),
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
  registerTerminalWebhookRoute(app);
}

/**
 * The payment terminal provider webhook (features/payment-terminals.md). Only
 * ID TECH has one (the simulated provider's events go through the worker
 * queue). The adapter checks the HMAC signature over the raw body with a
 * five-minute tolerance; each event is applied once under its lock, and a
 * money state change is confirmed by reading the transaction back from the
 * provider. 600 a minute.
 */
function registerTerminalWebhookRoute(app: FastifyInstance): void {
  app.post(
    '/webhooks/payment-terminals/idtech',
    {
      bodyLimit: TERMINAL_MAX_WEBHOOK_BYTES,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        tags: ['Webhooks'],
        summary: 'Handle ID TECH payment terminal events',
        description:
          'Receives ID TECH Payment Service Gateway events (transaction, device status and refund). Checks the x-psg-signature header (HMAC-SHA256 over the timestamp and the raw body with paymentTerminals.idtech.webhookSecretEnc, at most five minutes old), records each event id once (a replay is acknowledged and skipped), confirms the transaction state with the gateway and applies it. Answers {"received":true}.',
        operationId: 'handlePaymentTerminalWebhook',
        security: [],
        response: {
          200: stripeAck,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          401: errorWith('Signature missing or wrong', [ERROR_CODES.WEBHOOK_SIGNATURE_INVALID]),
          500: errorWith('Internal server error', [
            ERROR_CODES.INTERNAL_ERROR,
            ERROR_CODES.WEBHOOK_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const deps = {
        payments: paymentContext(request.log, {
          actor: 'system' as const,
          actorLabel: 'terminal-webhook:idtech',
        }),
        logger: request.log,
        portalUrl: apiConfig.PORTAL_URL,
      };
      let result;
      try {
        result = await ingestTerminalWebhook(
          'idtech',
          Buffer.from(request.body as string, 'utf8'),
          headerMap(request.headers),
          deps.payments,
        );
      } catch (err) {
        if (err instanceof WebhookNotConfiguredError) {
          request.log.error('Payment terminal webhook secret or credentials are not configured');
          await reply
            .status(500)
            .send({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
          return;
        }
        if (
          err instanceof TerminalProviderError &&
          (err.kind === 'auth' || err.kind === 'validation')
        ) {
          request.log.warn({ kind: err.kind }, 'Payment terminal webhook refused');
          if (err.kind === 'auth') {
            await reply
              .status(401)
              .send({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
          } else {
            await reply.status(400).send({ error: 'Invalid event', code: 'VALIDATION_ERROR' });
          }
          return;
        }
        throw err;
      }
      // The follow-up (an authorization starts charging) is fail-open: the
      // event is recorded, and the reconciliation voids a hold that never started.
      await handleTerminalResults(result.applied, 'idtech', deps);
      return { received: true };
    },
  );
}
