// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { UnrecoverableError, Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { z } from 'zod';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import {
  dispatchPaymentWebhookNotices,
  ingestPaymentWebhook,
  PAYMENT_WEBHOOK_CHANNEL,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '@evtivity/payments';
import type { PaymentWebhookDelivery, SimulatedEventSink } from '@evtivity/payments';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { PAYMENT_TEMPLATES_DIRS, paymentContext } from './lib/payments.js';

const log = createLogger('payment-webhook-worker');

const deliverySchema = z.object({
  provider: z.literal('simulated'),
  rawBody: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  delaySeconds: z.number().finite().nonnegative(),
});

/**
 * The provider plus the SHA-256 of the signed body. Every worker replica
 * receives each pub/sub message, so the deterministic id makes BullMQ keep
 * one job per delivery (P7). The pipeline also dedupes on the event id.
 */
export function paymentWebhookJobId(delivery: PaymentWebhookDelivery): string {
  const hash = crypto.createHash('sha256').update(delivery.rawBody).digest('hex');
  return `${delivery.provider}-${hash}`;
}

async function enqueue(queue: Queue, delivery: PaymentWebhookDelivery): Promise<void> {
  await queue.add('deliver', delivery, {
    jobId: paymentWebhookJobId(delivery),
    delay: Math.round(delivery.delaySeconds * 1000),
  });
}

/**
 * Sink for the simulated provider inside the worker: the worker's own events
 * go straight into the queue, without a round trip over pub/sub.
 */
export function queueSimulatedSink(queue: Queue): SimulatedEventSink {
  return {
    deliver: (delivery) => enqueue(queue, { provider: 'simulated', ...delivery }),
  };
}

/**
 * Subscribes to PAYMENT_WEBHOOK_CHANNEL (simulated provider events published
 * by the API and OCPP processes) and enqueues each as a delayed job.
 */
export async function startPaymentWebhookBridge(
  pubsub: PubSubClient,
  queue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(PAYMENT_WEBHOOK_CHANNEL, (payload: string) => {
    let delivery: PaymentWebhookDelivery;
    try {
      delivery = deliverySchema.parse(JSON.parse(payload));
    } catch (err) {
      log.warn({ err }, 'Malformed payment webhook delivery dropped');
      return;
    }
    enqueue(queue, delivery).catch((err: unknown) => {
      log.error({ err }, 'Failed to enqueue payment webhook delivery');
    });
  });

  log.info('Payment webhook bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Payment webhook bridge stopped');
  };
}

/**
 * Ingests delayed provider events through the webhook pipeline. A bad
 * signature or a provider this process does not have will not succeed on a
 * retry, so the job fails at once; other errors (database) are retried.
 * What the events changed is told to the driver and the operator UI
 * (`dispatchPaymentWebhookNotices`, fail-open) through `pubsub`.
 */
export function createPaymentWebhookWorker(
  connection: ConnectionOptions,
  pubsub: PubSubClient | null,
): Worker {
  return new Worker<PaymentWebhookDelivery>(
    QUEUE_NAMES.PAYMENT_WEBHOOKS,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.PAYMENT_WEBHOOKS);
      const startTime = Date.now();
      const { provider, rawBody, headers } = job.data;
      try {
        const result = await ingestPaymentWebhook(provider, rawBody, headers, paymentContext(log));
        if (result.notices.length > 0) {
          await dispatchPaymentWebhookNotices(result.notices, {
            templatesDirs: PAYMENT_TEMPLATES_DIRS,
            pubsub,
            logger: log,
          });
        }
        log.info(
          { jobId: job.id, provider, applied: result.applied, duplicates: result.duplicates },
          'Payment webhook delivered',
        );
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr, jobId: job.id }, 'Failed to record payment webhook job failure');
        });
        if (err instanceof WebhookSignatureError || err instanceof WebhookNotConfiguredError) {
          log.error({ err, jobId: job.id, provider }, 'Payment webhook rejected, not retried');
          throw new UnrecoverableError(errorMsg);
        }
        throw err;
      }
    },
    { connection, concurrency: 5 },
  );
}
