// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { clearPlatformFeeCache } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  clearPaymentSettingsCache,
  createPaymentRegistry,
  pubsubSimulatedSink,
  resolveActiveProvider,
} from '@evtivity/payments';
import type { PaymentContext, PaymentLogger, PaymentProvider } from '@evtivity/payments';
import { config } from './config.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/**
 * The API process's payment providers (@evtivity/payments), built once with
 * this process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED.
 * Simulated provider events (the dispute card) go to the worker over the
 * `payment_webhook_deliveries` channel of the process's pub/sub client.
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
  simulated: {
    events: pubsubSimulatedSink({
      publish: (channel, payload) => getPubSub().publish(channel, payload),
    }),
    logger: createLogger('payments'),
  },
});

export function paymentContext(logger: PaymentLogger): PaymentContext {
  return { registry: paymentRegistry, logger };
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
  return resolveActiveProvider(paymentContext(logger));
}
