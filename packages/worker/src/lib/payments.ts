// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getPaymentTerminalSettings } from '@evtivity/database';
import { createLogger, type ServiceLogger } from '@evtivity/lib';
import {
  allowsUnverifiedTerminalAdapters,
  resolvePaymentTerminalTestBaseUrl,
} from '@evtivity/lib/payment-terminal-env';
import { PaymentTerminalRegistry } from '@evtivity/payment-terminals';
import {
  createPaymentRegistry,
  deferredSimulatedSink,
  queueTerminalEventSink,
} from '@evtivity/payments';
import type { TerminalFlowDeps } from '@evtivity/services/payment-terminal-flow';
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

/**
 * The worker's payment terminal providers (features/payment-terminals.md),
 * built with PAYMENT_TERMINALS_ALLOW_SIMULATED. The simulated async device's
 * events go to this worker's own `payment-terminal-events` queue.
 */
export const terminalRegistry = new PaymentTerminalRegistry({
  readSettings: () => getPaymentTerminalSettings(config.SETTINGS_ENCRYPTION_KEY),
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENT_TERMINALS_ALLOW_SIMULATED,
  allowUnverified: allowsUnverifiedTerminalAdapters(process.env),
  testBaseUrl: resolvePaymentTerminalTestBaseUrl(process.env),
  simulatedEventSink: queueTerminalEventSink(),
});

/**
 * The payment context of one worker job: its audit rows name `system` with
 * the job (`payment-capture-retry`, `guest-session-cleanup`, ...).
 */
export function paymentContext(logger: PaymentLogger, jobLabel: string): PaymentContext {
  return {
    registry: paymentRegistry,
    terminals: terminalRegistry,
    logger,
    actor: { actor: 'system', actorLabel: jobLabel },
  };
}

/** The payment terminal flow of a worker job (receipt link, prompts, starts after an event). */
export function terminalFlowDeps(logger: PaymentLogger & ServiceLogger): TerminalFlowDeps {
  return {
    payments: paymentContext(logger, 'payment-terminal'),
    logger,
    portalUrl: config.PORTAL_URL,
  };
}

/** The notification templates of payment messages the worker sends. */
export const PAYMENT_TEMPLATES_DIRS = ALL_TEMPLATES_DIRS;

/** Guest session events also send the guest receipt, from the notification templates. */
export function guestEventDeps(logger: PaymentLogger): GuestEventDeps {
  return {
    ...paymentContext(logger, 'guest-session-worker'),
    templatesDirs: PAYMENT_TEMPLATES_DIRS,
  };
}
