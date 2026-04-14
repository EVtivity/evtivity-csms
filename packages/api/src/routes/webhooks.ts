// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, paymentRecords, webhookEvents } from '@evtivity/database';
import { verifyWebhookSignature } from '../services/stripe.service.js';
import { itemResponse, errorResponse } from '../lib/response-schemas.js';
import { config as apiConfig } from '../lib/config.js';

const webhookResponse = z.object({ received: z.literal(true) }).passthrough();

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
        response: { 200: itemResponse(webhookResponse), 400: errorResponse, 500: errorResponse },
      },
    },
    async (request, reply) => {
      const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'] ?? apiConfig.STRIPE_WEBHOOK_SECRET;
      if (webhookSecret == null || webhookSecret === '') {
        app.log.error('STRIPE_WEBHOOK_SECRET not configured');
        await reply.status(500).send({ error: 'Webhook not configured' });
        return;
      }

      const signature = request.headers['stripe-signature'];
      if (signature == null || typeof signature !== 'string') {
        await reply.status(400).send({ error: 'Missing stripe-signature header' });
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
        await reply.status(400).send({ error: 'Invalid signature' });
        return;
      }

      app.log.info({ type: event.type, id: event.id }, 'Stripe webhook received');

      // Deduplicate: reject events we have already processed.
      // Stripe may replay webhooks on timeout or network errors.
      const [existing] = await db
        .select({ eventId: webhookEvents.eventId })
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, event.id));
      if (existing != null) {
        app.log.info({ eventId: event.id }, 'Duplicate webhook event, skipping');
        await reply.status(200).send({ received: true });
        return;
      }

      // Record the event before processing to prevent races
      await db.insert(webhookEvents).values({ eventId: event.id, eventType: event.type });

      switch (event.type) {
        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          const [record] = await db
            .select()
            .from(paymentRecords)
            .where(eq(paymentRecords.stripePaymentIntentId, pi.id));
          if (record != null) {
            await db
              .update(paymentRecords)
              .set({ status: 'failed', updatedAt: new Date() })
              .where(eq(paymentRecords.id, record.id));
            app.log.info({ paymentIntentId: pi.id }, 'Payment marked as failed via webhook');
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
              const newStatus =
                charge.amount_refunded === charge.amount ? 'refunded' : 'partially_refunded';
              await db
                .update(paymentRecords)
                .set({ status: newStatus, updatedAt: new Date() })
                .where(eq(paymentRecords.id, record.id));
              app.log.info(
                { paymentIntentId: piId, status: newStatus },
                'Payment refund status updated via webhook',
              );
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
