// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Payment terminal settings: names, values and limits. Browser-safe, so the
 * CSMS settings card imports them via `@evtivity/lib/payment-terminal-settings`.
 * The secrets end in `Enc` (P12) and are entered in the dashboard only.
 */

export const PAYMENT_TERMINAL_SETTING_KEYS = Object.freeze({
  idtechEnabled: 'paymentTerminals.idtech.enabled',
  idtechEnvironment: 'paymentTerminals.idtech.environment',
  idtechMerchantId: 'paymentTerminals.idtech.merchantId',
  idtechApiKeyEnc: 'paymentTerminals.idtech.apiKeyEnc',
  idtechApiSecretEnc: 'paymentTerminals.idtech.apiSecretEnc',
  idtechWebhookSecretEnc: 'paymentTerminals.idtech.webhookSecretEnc',
});

export const PAYMENT_TERMINAL_SETTING_KEY_LIST: readonly string[] = Object.freeze(
  Object.values(PAYMENT_TERMINAL_SETTING_KEYS),
);

export const IDTECH_ENVIRONMENTS = Object.freeze(['sandbox', 'production'] as const);
export type IdtechEnvironmentSetting = (typeof IDTECH_ENVIRONMENTS)[number];

export function isIdtechEnvironment(value: unknown): value is IdtechEnvironmentSetting {
  return IDTECH_ENVIRONMENTS.includes(value as IdtechEnvironmentSetting);
}

/** An ID TECH merchant id: 1 to 64 letters, digits, `_` or `-`. */
const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isIdtechMerchantId(value: string): boolean {
  return MERCHANT_ID.test(value.trim());
}

/** How long a terminal waits for a card after a payment starts. */
export const PAYMENT_TERMINAL_CARD_TIMEOUT_SECONDS = 90;

/** How long an authorized terminal payment waits for the station to start the transaction (the guest session expiry). */
export const PAYMENT_TERMINAL_START_TTL_MINUTES = 15;

/** A terminal offline this long raises the station watch alert. */
export const PAYMENT_TERMINAL_OFFLINE_ALERT_MINUTES = 15;

/** The default hold of a terminal payment when the site has no hold amount, in cents. */
export const PAYMENT_TERMINAL_DEFAULT_HOLD_CENTS = 5000;

/** The terminal providers an operator picks from. */
export const PAYMENT_TERMINAL_PROVIDERS = Object.freeze(['simulated', 'idtech'] as const);
export type PaymentTerminalProviderSetting = (typeof PAYMENT_TERMINAL_PROVIDERS)[number];

/** The device models the CSMS knows, with what each one has. */
export const PAYMENT_TERMINAL_MODELS = Object.freeze({
  VP6825: Object.freeze({
    display: true,
    cellular: true,
    entry: ['chip', 'contactless', 'swipe', 'pin'] as const,
  }),
  VP7200: Object.freeze({ display: false, cellular: false, entry: ['contactless'] as const }),
});

/** True when the terminal model shows prompts on its own screen; the VP7200 uses the station display. */
export function terminalModelHasDisplay(model: string | null | undefined): boolean {
  return model !== 'VP7200';
}
