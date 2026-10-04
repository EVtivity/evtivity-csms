// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { SimulatedEventSink, SimulatedWebhookDelivery } from './providers/simulated/index.js';

/**
 * Pub/sub channel of signed simulated provider events on their way to the
 * worker, which delays them in the `payment-webhooks` queue and ingests them
 * through `ingestPaymentWebhook` (D-T2). Not `csms_events`: that channel
 * streams to operator browsers and must not carry signed bodies.
 */
export const PAYMENT_WEBHOOK_CHANNEL = 'payment_webhook_deliveries';

/** A message on PAYMENT_WEBHOOK_CHANNEL. */
export interface PaymentWebhookDelivery extends SimulatedWebhookDelivery {
  provider: 'simulated';
}

export interface PaymentWebhookPublisher {
  publish(channel: string, payload: string): Promise<void>;
}

/**
 * Sink for the simulated provider in the API and OCPP processes: publish on
 * PAYMENT_WEBHOOK_CHANNEL, the worker delays and ingests. A publish failure
 * rejects, and the provider logs it at warn (P9).
 */
export function pubsubSimulatedSink(pubsub: PaymentWebhookPublisher): SimulatedEventSink {
  return {
    async deliver(delivery) {
      const message: PaymentWebhookDelivery = { provider: 'simulated', ...delivery };
      await pubsub.publish(PAYMENT_WEBHOOK_CHANNEL, JSON.stringify(message));
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
