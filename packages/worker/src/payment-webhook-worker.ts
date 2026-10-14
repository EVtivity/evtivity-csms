// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import {
  dispatchPaymentWebhookNotices,
  ingestPaymentWebhook,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '@evtivity/payments';
import type { PaymentWebhookDelivery } from '@evtivity/payments';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { PAYMENT_TEMPLATES_DIRS, paymentContext } from './lib/payments.js';

const log = createLogger('payment-webhook-worker');

/**
 * Ingests delayed provider events through the webhook pipeline. Every process
 * with the simulated provider adds the jobs itself (queueSimulatedSink in
 * @evtivity/payments), so an event waits while no worker runs. A bad
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
        const result = await ingestPaymentWebhook(
          provider,
          rawBody,
          headers,
          // ingestPaymentWebhook names the provider's webhook as the actor.
          paymentContext(log, 'payment-webhooks'),
        );
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
