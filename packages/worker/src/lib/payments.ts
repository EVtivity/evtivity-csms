// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentRegistry } from '@evtivity/payments';
import type { GuestEventDeps, PaymentContext, PaymentLogger } from '@evtivity/payments';
import { config } from './config.js';

/**
 * The worker's payment providers (@evtivity/payments), built once with this
 * process's SETTINGS_ENCRYPTION_KEY and PAYMENTS_ALLOW_SIMULATED. The worker
 * imports no payment code from the API (P8).
 */
export const paymentRegistry = createPaymentRegistry({
  encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
  allowSimulated: config.PAYMENTS_ALLOW_SIMULATED,
});

export function paymentContext(logger: PaymentLogger): PaymentContext {
  return { registry: paymentRegistry, logger };
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');

/** Guest session events also send the guest receipt, from the notification templates. */
export function guestEventDeps(logger: PaymentLogger): GuestEventDeps {
  return { ...paymentContext(logger), templatesDirs: [OCPP_TEMPLATES_DIR, API_TEMPLATES_DIR] };
}
