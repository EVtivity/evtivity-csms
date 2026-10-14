// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { jobQueue } from '@evtivity/lib/job-queues';
import { PAYMENT_WEBHOOK_JOB_OPTIONS, PAYMENT_WEBHOOK_QUEUE } from '@evtivity/lib/worker-queues';
import type { SimulatedEventSink, SimulatedWebhookDelivery } from './providers/simulated/index.js';

/**
 * The BullMQ job name of one signed simulated provider event on the worker's
 * payment-webhooks queue: the worker delays it and ingests it through
 * `ingestPaymentWebhook` (D-T2). Every process with the simulated provider
 * adds the jobs itself, so an event waits in Redis while no worker runs.
 */
export const PAYMENT_WEBHOOK_JOB_NAME = 'deliver';

/** One job of the payment webhook queue. */
export interface PaymentWebhookDelivery extends SimulatedWebhookDelivery {
  provider: 'simulated';
}

/**
 * The provider plus the SHA-256 of the signed body, so the same delivery
 * added twice makes one job (P7). The pipeline also dedupes on the event id.
 */
export function paymentWebhookJobId(delivery: PaymentWebhookDelivery): string {
  const hash = crypto.createHash('sha256').update(delivery.rawBody).digest('hex');
  return `${delivery.provider}-${hash}`;
}

/**
 * Sink for the simulated provider: adds each event to the worker's
 * `payment-webhooks` queue, delayed by its `delaySeconds`. A failed add
 * rejects, and the provider logs it at warn (P9).
 */
export function queueSimulatedSink(): SimulatedEventSink {
  return {
    async deliver(event) {
      const delivery: PaymentWebhookDelivery = { provider: 'simulated', ...event };
      await jobQueue(PAYMENT_WEBHOOK_QUEUE, PAYMENT_WEBHOOK_JOB_OPTIONS).add(
        PAYMENT_WEBHOOK_JOB_NAME,
        delivery,
        { jobId: paymentWebhookJobId(delivery), delay: Math.round(delivery.delaySeconds * 1000) },
      );
    },
  };
}

export interface DeferredSimulatedSink extends SimulatedEventSink {
  /** Connects the real sink at startup; null disconnects it at shutdown. */
  bind(sink: SimulatedEventSink | null): void;
}

/**
 * A sink for a registry built before the process has its pub/sub client or
 * queue. Until bound, a delivery rejects, so the provider logs the lost event
 * instead of dropping it silently.
 */
export function deferredSimulatedSink(): DeferredSimulatedSink {
  let target: SimulatedEventSink | null = null;
  return {
    bind(sink) {
      target = sink;
    },
    deliver(delivery: SimulatedWebhookDelivery) {
      if (target == null) {
        return Promise.reject(new Error('Simulated event sink is not connected'));
      }
      return target.deliver(delivery);
    },
  };
}
