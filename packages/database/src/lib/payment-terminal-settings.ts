// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import {
  createLogger,
  decryptSettingOrNull,
  isIdtechEnvironment,
  PAYMENT_TERMINAL_SETTING_KEYS,
  type IdtechEnvironmentSetting,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('payment-terminal-settings');

/** Same shape as the settings of `@evtivity/payment-terminals` (TerminalProviderSettings). */
export interface PaymentTerminalSettings {
  idtech: {
    enabled: boolean;
    environment: IdtechEnvironmentSetting;
    merchantId: string;
    apiKey: string;
    apiSecret: string;
    webhookSecret: string;
  };
}

const CACHE_TTL_MS = 60_000;

let cached: { value: PaymentTerminalSettings; at: number } | undefined;

function secret(value: unknown, encryptionKey: string, key: string): string {
  try {
    return (decryptSettingOrNull(value, encryptionKey) ?? '').trim();
  } catch (err: unknown) {
    logger.warn({ err, key }, 'Payment terminal secret decryption failed, the provider has none');
    return '';
  }
}

export function parsePaymentTerminalSettings(
  rows: readonly { key: string; value: unknown }[],
  encryptionKey: string,
): PaymentTerminalSettings {
  const map: Record<string, unknown> = {};
  for (const row of rows) map[row.key] = row.value;
  const K = PAYMENT_TERMINAL_SETTING_KEYS;
  const environment = map[K.idtechEnvironment];
  const merchant = map[K.idtechMerchantId];
  return {
    idtech: {
      enabled: map[K.idtechEnabled] === true,
      environment: isIdtechEnvironment(environment) ? environment : 'sandbox',
      merchantId: typeof merchant === 'string' ? merchant.trim() : '',
      apiKey: secret(map[K.idtechApiKeyEnc], encryptionKey, K.idtechApiKeyEnc),
      apiSecret: secret(map[K.idtechApiSecretEnc], encryptionKey, K.idtechApiSecretEnc),
      webhookSecret: secret(map[K.idtechWebhookSecretEnc], encryptionKey, K.idtechWebhookSecretEnc),
    },
  };
}

function defaults(): PaymentTerminalSettings {
  return {
    idtech: {
      enabled: false,
      environment: 'sandbox',
      merchantId: '',
      apiKey: '',
      apiSecret: '',
      webhookSecret: '',
    },
  };
}

/**
 * The payment terminal settings (`paymentTerminals.*`) with the secrets
 * decrypted, read once a minute per process (P6). A failed read keeps the
 * last value, or the defaults (every provider off) when there is none.
 */
export async function getPaymentTerminalSettings(
  encryptionKey: string,
): Promise<PaymentTerminalSettings> {
  const now = Date.now();
  if (cached != null && now - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'paymentTerminals.%'));
    const value = parsePaymentTerminalSettings(rows, encryptionKey);
    cached = { value, at: now };
    return value;
  } catch (err: unknown) {
    logger.warn(
      { err },
      'Payment terminal settings read failed, using the cached value or the defaults',
    );
    return cached?.value ?? defaults();
  }
}

/** Call after a payment terminal settings write so the next read sees it. */
export function clearPaymentTerminalSettingsCache(): void {
  cached = undefined;
}
