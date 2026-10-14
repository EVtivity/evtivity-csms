// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import {
  createPaymentRegistry,
  PAYMENT_SYSTEM_ACTOR,
  deferredSimulatedSink,
  resolveActiveProvider,
} from '@evtivity/payments';
import type {
  PaymentActor,
  PaymentContext,
  PaymentLogger,
  PaymentProvider,
  SimulatedEventSink,
} from '@evtivity/payments';
import { config } from './config.js';

/**
 * Simulated provider events (the dispute card) are added to the worker's
 * `payment-webhooks` queue. The job queues exist only after startup, so the
 * sink is connected by setSimulatedEventSink.
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

/**
 * The payment context of one caller. `actor` is who the audit rows of the
 * payment writes name: `ocpp` with the message or step for a station's
 * message, `system` with the reason for a CSMS decision.
 */
export function paymentContext(logger: PaymentLogger, actor: PaymentActor): PaymentContext {
  return { registry: paymentRegistry, logger, actor };
}

/**
 * The provider for new payments in this process, or null when payments are off
 * or the selected provider is not usable here (resolveActiveProvider).
 */
export function activePaymentProvider(logger: PaymentLogger): Promise<PaymentProvider | null> {
  // A read: resolving the provider writes nothing.
  return resolveActiveProvider(paymentContext(logger, PAYMENT_SYSTEM_ACTOR));
}

/** Connects the simulated provider's events at startup (queueSimulatedSink); null at shutdown. */
export function setSimulatedEventSink(sink: SimulatedEventSink | null): void {
  simulatedEvents.bind(sink);
}
