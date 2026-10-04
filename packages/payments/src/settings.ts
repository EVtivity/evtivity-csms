// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray } from 'drizzle-orm';
import { decryptString } from '@evtivity/lib';
import type { PayoutAccountState } from './types.js';
import { db, settings, sitePaymentConfigs } from '@evtivity/database';

/** `payments.provider` value that turns payments off. */
export const NO_PAYMENT_PROVIDER = 'none';

/** Fallback hold amount when `payments.preAuthAmountCents` is unset (the seeded default). */
export const DEFAULT_PRE_AUTH_AMOUNT_CENTS = 5000;

/** Test (simulated) provider settings (`simulated.*`, migration 0125). */
export interface SimulatedSettings {
  /** 'sync' (Stripe-like) or 'async' (Adyen-like, results arrive as webhooks). */
  resultMode: 'sync' | 'async';
  /** Delay of async results in seconds (0 to 3600). */
  asyncDelaySeconds: number;
  /** Failure rate of methods without a scenario (seeded data), 0 to 1. */
  randomFailureRate: number;
}

/** The seeded `simulated.*` values, used for a missing or invalid stored value. */
export const DEFAULT_SIMULATED_SETTINGS: Readonly<SimulatedSettings> = {
  resultMode: 'sync',
  asyncDelaySeconds: 3,
  randomFailureRate: 0.2,
};

export interface StripeSettings {
  secretKey: string | null;
  publishableKey: string | null;
  /** Signing secret of the platform webhook endpoint (`stripe.webhookSecretEnc`). */
  webhookSecret: string | null;
  /** Signing secret of the Connect webhook endpoint (`stripe.connectWebhookSecretEnc`). */
  connectWebhookSecret: string | null;
}

/** Client SDK live regions (https://docs.adyen.com/online-payments/build-your-integration/advanced-flow). */
export const ADYEN_LIVE_REGIONS = ['eu', 'us', 'au', 'nea', 'in'] as const;
export type AdyenLiveRegion = (typeof ADYEN_LIVE_REGIONS)[number];

export interface AdyenSettings {
  apiKey: string | null;
  merchantAccount: string | null;
  /** Public client key for the browser and mobile SDKs (not a secret). */
  clientKey: string | null;
  environment: 'test' | 'live';
  /** Required when live (Customer Area > Developers > API URLs). */
  liveUrlPrefix: string | null;
  liveRegion: AdyenLiveRegion;
  /** Hex HMAC key of the webhook endpoint. */
  hmacKey: string | null;
  /** The previous HMAC key, accepted during a key rotation. */
  hmacKeyPrevious: string | null;
  webhookUsername: string | null;
  webhookPassword: string | null;
  /** Raise the hold with an authorization adjustment instead of a top-up charge (D-A1). */
  authorisationAdjustment: boolean;
}

export interface PaymentSettings {
  /** Active provider id, or NO_PAYMENT_PROVIDER. */
  provider: string;
  preAuthAmountCents: number;
  stripe: StripeSettings;
  adyen: AdyenSettings;
  simulated: SimulatedSettings;
}

export interface SitePaymentConfig {
  configId: number;
  /** Stripe connected account of the site (`acct_...`), or null. */
  payoutAccountId: string | null;
  /** The payout account's state as last read from the provider; null when never read. */
  payoutAccountStatus: PayoutAccountState | null;
  preAuthAmountCents: number;
}

const TTL_MS = 60_000;
const KEYS = [
  'payments.provider',
  'stripe.secretKeyEnc',
  'stripe.publishableKey',
  'stripe.webhookSecretEnc',
  'stripe.connectWebhookSecretEnc',
  'payments.preAuthAmountCents',
  'adyen.apiKeyEnc',
  'adyen.merchantAccount',
  'adyen.clientKey',
  'adyen.environment',
  'adyen.liveUrlPrefix',
  'adyen.liveRegion',
  'adyen.hmacKeyEnc',
  'adyen.hmacKeyPreviousEnc',
  'adyen.webhookUsername',
  'adyen.webhookPasswordEnc',
  'adyen.authorisationAdjustment',
  'simulated.resultMode',
  'simulated.asyncDelaySeconds',
  'simulated.randomFailureRate',
];

let settingsCache: { value: PaymentSettings; cachedAt: number } | null = null;
const siteCache = new Map<string, { value: SitePaymentConfig | null; cachedAt: number }>();

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function decrypted(value: unknown, encryptionKey: string): string | null {
  const stored = nonEmptyString(value);
  return stored == null ? null : decryptString(stored, encryptionKey);
}

function adyenSettings(byKey: Map<string, unknown>, encryptionKey: string): AdyenSettings {
  const region = byKey.get('adyen.liveRegion');
  const adjustment = byKey.get('adyen.authorisationAdjustment');
  return {
    apiKey: decrypted(byKey.get('adyen.apiKeyEnc'), encryptionKey),
    merchantAccount: nonEmptyString(byKey.get('adyen.merchantAccount')),
    clientKey: nonEmptyString(byKey.get('adyen.clientKey')),
    environment: byKey.get('adyen.environment') === 'live' ? 'live' : 'test',
    liveUrlPrefix: nonEmptyString(byKey.get('adyen.liveUrlPrefix')),
    liveRegion: ADYEN_LIVE_REGIONS.find((r) => r === region) ?? 'eu',
    hmacKey: decrypted(byKey.get('adyen.hmacKeyEnc'), encryptionKey),
    hmacKeyPrevious: decrypted(byKey.get('adyen.hmacKeyPreviousEnc'), encryptionKey),
    webhookUsername: nonEmptyString(byKey.get('adyen.webhookUsername')),
    webhookPassword: decrypted(byKey.get('adyen.webhookPasswordEnc'), encryptionKey),
    authorisationAdjustment: adjustment === true || adjustment === 'true',
  };
}

/** A stored number within [min, max], else the fallback (unset, empty or out of range). */
function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function simulatedSettings(byKey: Map<string, unknown>): SimulatedSettings {
  const defaults = DEFAULT_SIMULATED_SETTINGS;
  return {
    resultMode: byKey.get('simulated.resultMode') === 'async' ? 'async' : defaults.resultMode,
    asyncDelaySeconds: numberInRange(
      byKey.get('simulated.asyncDelaySeconds'),
      0,
      3600,
      defaults.asyncDelaySeconds,
    ),
    randomFailureRate: numberInRange(
      byKey.get('simulated.randomFailureRate'),
      0,
      1,
      defaults.randomFailureRate,
    ),
  };
}

/**
 * The payment settings, with `*Enc` values decrypted with the caller's
 * SETTINGS_ENCRYPTION_KEY. Cached for 60 seconds. A read failure returns the
 * last cached value and throws without one; a decrypt failure always throws,
 * so a payment never runs on a key it cannot read.
 */
export async function getPaymentSettings(encryptionKey: string): Promise<PaymentSettings> {
  const now = Date.now();
  if (settingsCache != null && now - settingsCache.cachedAt < TTL_MS) return settingsCache.value;

  let rows: Array<{ key: string; value: unknown }>;
  try {
    rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, KEYS));
  } catch (err) {
    if (settingsCache != null) return settingsCache.value;
    throw err;
  }
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const preAuth = Number(byKey.get('payments.preAuthAmountCents'));
  const value: PaymentSettings = {
    provider: nonEmptyString(byKey.get('payments.provider')) ?? NO_PAYMENT_PROVIDER,
    preAuthAmountCents:
      Number.isInteger(preAuth) && preAuth > 0 ? preAuth : DEFAULT_PRE_AUTH_AMOUNT_CENTS,
    stripe: {
      secretKey: decrypted(byKey.get('stripe.secretKeyEnc'), encryptionKey),
      publishableKey: nonEmptyString(byKey.get('stripe.publishableKey')),
      webhookSecret: decrypted(byKey.get('stripe.webhookSecretEnc'), encryptionKey),
      connectWebhookSecret: decrypted(byKey.get('stripe.connectWebhookSecretEnc'), encryptionKey),
    },
    adyen: adyenSettings(byKey, encryptionKey),
    simulated: simulatedSettings(byKey),
  };
  settingsCache = { value, cachedAt: now };
  return value;
}

/**
 * The enabled payment config of a site (payout account, its status and the hold amount), or
 * null when the site has none or it is disabled. Cached per site for 60 seconds,
 * with the same read-failure rule as getPaymentSettings.
 */
export async function getSitePaymentConfig(siteId: string): Promise<SitePaymentConfig | null> {
  const now = Date.now();
  const cached = siteCache.get(siteId);
  if (cached != null && now - cached.cachedAt < TTL_MS) return cached.value;

  let rows: Array<{
    id: number;
    accountId: string | null;
    payoutAccountStatus: string | null;
    preAuthAmountCents: number;
  }>;
  try {
    rows = await db
      .select({
        id: sitePaymentConfigs.id,
        accountId: sitePaymentConfigs.payoutAccountId,
        payoutAccountStatus: sitePaymentConfigs.payoutAccountStatus,
        preAuthAmountCents: sitePaymentConfigs.preAuthAmountCents,
      })
      .from(sitePaymentConfigs)
      .where(and(eq(sitePaymentConfigs.siteId, siteId), eq(sitePaymentConfigs.isEnabled, true)));
  } catch (err) {
    if (cached != null) return cached.value;
    throw err;
  }
  const row = rows[0];
  const value =
    row == null
      ? null
      : {
          configId: row.id,
          payoutAccountId: nonEmptyString(row.accountId),
          payoutAccountStatus: row.payoutAccountStatus as PayoutAccountState | null,
          preAuthAmountCents: row.preAuthAmountCents,
        };
  siteCache.set(siteId, { value, cachedAt: now });
  return value;
}

/** Drop the cached payment settings and site configs (after a settings change). */
export function clearPaymentSettingsCache(): void {
  settingsCache = null;
  siteCache.clear();
}
