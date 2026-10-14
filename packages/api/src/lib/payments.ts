// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { clearPlatformFeeCache } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  clearPaymentSettingsCache,
  createPaymentRegistry,
  PAYMENT_SYSTEM_ACTOR,
  queueSimulatedSink,
  resolveActiveProvider,
} from '@evtivity/payments';
import type {
  PaymentActor,
  PaymentContext,
  PaymentLogger,
  PaymentProvider,
} from '@evtivity/payments';
import { config } from './config.js';

/**
 * The API process's payment providers (@evtivity/payments), built once with
 * this process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED.
 * Simulated provider events (the dispute card) are added to the worker's
 * `payment-webhooks` queue (the job queues are initialized at startup).
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
  simulated: {
    events: queueSimulatedSink(),
    logger: createLogger('payments'),
  },
});

/**
 * The payment context of one call. `actor` is who the audit rows of the
 * payment writes name: `getAuditActor(request)` in a route, or `system` with
 * the reason for a call no request made.
 */
export function paymentContext(logger: PaymentLogger, actor: PaymentActor): PaymentContext {
  return { registry: paymentRegistry, logger, actor };
}

/**
 * Drops the cached payment settings, site configs, platform fee percents and
 * built providers of this process, after a payment setting or site payment
 * config changes. Other processes pick the change up within 60 seconds.
 */
export function clearPaymentCaches(): void {
  clearPaymentSettingsCache();
  clearPlatformFeeCache();
  paymentRegistry.clearCache();
}

/** Keys whose change must drop the payment caches (generic settings routes). */
export function isPaymentSettingKey(key: string): boolean {
  return (
    key.startsWith('payments.') ||
    key.startsWith('stripe.') ||
    key.startsWith('adyen.') ||
    key.startsWith('simulated.')
  );
}

/**
 * The provider for new payments in this process, or null when payments are off
 * or the selected provider is not usable here (resolveActiveProvider).
 */
export function activePaymentProvider(logger: PaymentLogger): Promise<PaymentProvider | null> {
  // A read: resolving the provider writes nothing.
  return resolveActiveProvider(paymentContext(logger, PAYMENT_SYSTEM_ACTOR));
}
