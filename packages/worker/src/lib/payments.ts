// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import { createPaymentRegistry, deferredSimulatedSink } from '@evtivity/payments';
import type {
  GuestEventDeps,
  PaymentContext,
  PaymentLogger,
  SimulatedEventSink,
} from '@evtivity/payments';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from './config.js';

/**
 * Simulated provider events raised in the worker (a guest capture on the
 * dispute card) go straight into the `payment-webhooks` queue, which exists
 * only after startup, so the sink is connected by setSimulatedEventSink.
 */
const simulatedEvents = deferredSimulatedSink();

/**
 * The worker's payment providers (@evtivity/payments), built once with this
 * process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED. The worker
 * imports no payment code from the API (P8).
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
  simulated: { events: simulatedEvents, logger: createLogger('payments') },
});

/** Connects the simulated provider's events to the queue at startup; null at shutdown. */
export function setSimulatedEventSink(sink: SimulatedEventSink | null): void {
  simulatedEvents.bind(sink);
}

export function paymentContext(logger: PaymentLogger): PaymentContext {
  return { registry: paymentRegistry, logger };
}

/** The notification templates of payment messages the worker sends. */
export const PAYMENT_TEMPLATES_DIRS = ALL_TEMPLATES_DIRS;

/** Guest session events also send the guest receipt, from the notification templates. */
export function guestEventDeps(logger: PaymentLogger): GuestEventDeps {
  return { ...paymentContext(logger), templatesDirs: PAYMENT_TEMPLATES_DIRS };
}
