// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createPaymentRegistry } from '@evtivity/payments';
import type { PaymentContext, PaymentLogger } from '@evtivity/payments';
import { config } from './config.js';

/**
 * The OCPP process's payment providers (@evtivity/payments), built once with
 * this process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED. The
 * payment gate and the capture on session end go through it.
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
});

export function paymentContext(logger: PaymentLogger): PaymentContext {
  return { registry: paymentRegistry, logger };
}
