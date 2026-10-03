// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { db, paymentRecords, webhookEvents, getStripeWebhookSecret } from '@evtivity/database';
import { verifyWebhookSignature } from '../services/stripe.service.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { config as apiConfig } from '../lib/config.js';

const webhookResponse = z
  .object({ received: z.literal(true).describe('Acknowledgement that the webhook was processed') })
  .passthrough();

// Statuses a webhook may move to failed or refunded. Every other status is
// terminal for that event (design principle P5).
const FAILABLE_STATUSES: Array<'pending' | 'pre_authorized'> = ['pending', 'pre_authorized'];
const REFUNDABLE_STATUSES: Array<'captured' | 'partially_refunded'> = [
  'captured',
  'partially_refunded',
];

export function webhookRoutes(app: FastifyInstance): void {
  // Use string parsing for raw body access (needed for Stripe signature verification).
  // This is encapsulated by Fastify's plugin scope and does not affect other routes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    '/webhooks/stripe',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Handle Stripe webhook events',
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
      // The signing secret is the `stripe.webhookSecretEnc` setting
      // (Settings > Payment > Stripe), read through a 60 s cache.
      const webhookSecret = await getStripeWebhookSecret(apiConfig.SETTINGS_ENCRYPTION_KEY);
      if (webhookSecret == null) {
        app.log.error('Stripe webhook signing secret is not configured (stripe.webhookSecretEnc)');
        await reply
          .status(500)
          .send({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
        return;
      }

      const signature = request.headers['stripe-signature'];
      if (signature == null || typeof signature !== 'string') {
        await reply
          .status(400)
          .send({ error: 'Missing stripe-signature header', code: 'WEBHOOK_SIGNATURE_MISSING' });
        return;
      }

      const rawBody = request.body as string;

      let event: Stripe.Event;
      try {
        event = verifyWebhookSignature(rawBody, signature, webhookSecret);
      } catch (err) {
        app.log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Webhook signature verification failed',
        );
        await reply
          .status(400)
          .send({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
        return;
      }

      app.log.info({ type: event.type, id: event.id }, 'Stripe webhook received');

      // Deduplicate: reject events we have already processed.
      // Stripe may replay webhooks on timeout or network errors. Use a
      // single INSERT ... ON CONFLICT DO NOTHING + RETURNING to avoid the
      // SELECT-then-INSERT race that would 500 the second concurrent
      // delivery on the unique constraint.
      const inserted = await db
        .insert(webhookEvents)
        .values({ eventId: event.id, eventType: event.type })
        .onConflictDoNothing()
        .returning({ eventId: webhookEvents.eventId });
      if (inserted.length === 0) {
        app.log.info({ eventId: event.id }, 'Duplicate webhook event, skipping');
        await reply.status(200).send({ received: true });
        return;
      }

      switch (event.type) {
        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          const [record] = await db
            .select()
            .from(paymentRecords)
            .where(eq(paymentRecords.stripePaymentIntentId, pi.id));
          if (record != null) {
            const stripeFailureMessage =
              pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? null;
            const failureReason =
              stripeFailureMessage != null
                ? `Stripe webhook: ${stripeFailureMessage.slice(0, 480)}`
                : 'Stripe webhook: payment_intent.payment_failed';
            // Terminal states are sticky (P5): a failure event never
            // overwrites a captured, refunded, cancelled or failed record.
            const updated = await db
              .update(paymentRecords)
              .set({
                status: 'failed',
                failureReason,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(paymentRecords.id, record.id),
                  inArray(paymentRecords.status, FAILABLE_STATUSES),
                ),
              )
              .returning({ id: paymentRecords.id });
            if (updated.length > 0) {
              app.log.info(
                { paymentIntentId: pi.id, reason: stripeFailureMessage },
                'Payment marked as failed via webhook',
              );
            } else {
              app.log.info(
                { paymentIntentId: pi.id, status: record.status },
                'Payment failure webhook ignored: record is in a terminal state',
              );
            }
          }
          break;
        }
        case 'charge.refunded': {
          const charge = event.data.object;
          if (charge.payment_intent != null) {
            const piId =
              typeof charge.payment_intent === 'string'
                ? charge.payment_intent
                : charge.payment_intent.id;
            const [record] = await db
              .select()
              .from(paymentRecords)
              .where(eq(paymentRecords.stripePaymentIntentId, piId));
            if (record != null) {
              const refundedAmount = charge.amount_refunded;
              // A partially captured hold has amount > amount_captured; the
              // refundable total is what was captured.
              const newStatus =
                refundedAmount >= charge.amount_captured ? 'refunded' : 'partially_refunded';
              // Only a captured or partially refunded record takes a refund,
              // and a delayed event with a smaller refunded total never
              // lowers the stored one (P5).
              const updated = await db
                .update(paymentRecords)
                .set({
                  status: newStatus,
                  refundedAmountCents: refundedAmount,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(paymentRecords.id, record.id),
                    inArray(paymentRecords.status, REFUNDABLE_STATUSES),
                    lte(paymentRecords.refundedAmountCents, refundedAmount),
                  ),
                )
                .returning({ id: paymentRecords.id });
              if (updated.length > 0) {
                app.log.info(
                  { paymentIntentId: piId, status: newStatus, refundedAmount },
                  'Payment refund status updated via webhook',
                );
              } else {
                app.log.info(
                  {
                    paymentIntentId: piId,
                    status: record.status,
                    refundedAmountCents: record.refundedAmountCents,
                    refundedAmount,
                  },
                  'Refund webhook ignored: record not refundable or already refunded further',
                );
              }
            }
          }
          break;
        }
        case 'charge.dispute.created': {
          const dispute = event.data.object;
          if (dispute.payment_intent != null) {
            const piId =
              typeof dispute.payment_intent === 'string'
                ? dispute.payment_intent
                : dispute.payment_intent.id;
            app.log.warn(
              { paymentIntentId: piId, disputeId: dispute.id, reason: dispute.reason },
              'Payment dispute created',
            );
          }
          break;
        }
        default:
          app.log.debug({ type: event.type }, 'Unhandled webhook event type');
      }

      await reply.status(200).send({ received: true });
    },
  );
}
