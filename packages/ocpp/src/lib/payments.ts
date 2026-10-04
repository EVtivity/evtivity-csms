// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import {
  createPaymentRegistry,
  deferredSimulatedSink,
  pubsubSimulatedSink,
} from '@evtivity/payments';
import type { PaymentContext, PaymentLogger, PaymentWebhookPublisher } from '@evtivity/payments';
import { config } from './config.js';

/**
 * Simulated provider events (the dispute card) go to the worker over the
 * `payment_webhook_deliveries` channel. The pub/sub client exists only after
 * startup, so the sink is connected by setPaymentPubSub.
 */
const simulatedEvents = deferredSimulatedSink();

/**
 * The OCPP process's payment providers (@evtivity/payments), built once with
 * this process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED. The
 * payment gate and the capture on session end go through it.
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
  simulated: { events: simulatedEvents, logger: createLogger('payments') },
});

export function paymentContext(logger: PaymentLogger): PaymentContext {
  return { registry: paymentRegistry, logger };
}

/** Connects the simulated provider's events to pub/sub at startup; null at shutdown. */
export function setPaymentPubSub(pubsub: PaymentWebhookPublisher | null): void {
  simulatedEvents.bind(pubsub == null ? null : pubsubSimulatedSink(pubsub));
}
