// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { decryptString } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { sitePaymentConfigs } from '../schema/payments.js';

/**
 * The Stripe Connect platform fee percent (0 to 100) for charges at a site:
 * the enabled site payment config's `platform_fee_percent` when set, else the
 * `stripe.platformFeePercent` setting, else 0. The fee itself is
 * platformFeeCents (@evtivity/lib), a percent of the net amount charged.
 *
 * Cached per site for 60 seconds. A read failure falls back to the last
 * cached value and rethrows without one, so a charge never silently goes out
 * without its fee.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { percent: number; cachedAt: number }>();

export async function getPlatformFeePercent(siteId: string | null): Promise<number> {
  const key = siteId ?? '';
  const cached = cache.get(key);
  const now = Date.now();
  if (cached != null && now - cached.cachedAt < TTL_MS) return cached.percent;

  try {
    const [platformRows, siteRows] = await Promise.all([
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'stripe.platformFeePercent')),
      siteId != null
        ? db
            .select({ percent: sitePaymentConfigs.platformFeePercent })
            .from(sitePaymentConfigs)
            .where(
              and(eq(sitePaymentConfigs.siteId, siteId), eq(sitePaymentConfigs.isEnabled, true)),
            )
        : Promise.resolve([] as Array<{ percent: string | null }>),
    ]);
    const sitePercent = siteRows[0]?.percent;
    const raw = sitePercent ?? platformRows[0]?.value ?? 0;
    const parsed = Number(raw);
    const percent = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 0;
    cache.set(key, { percent, cachedAt: now });
    return percent;
  } catch (err) {
    if (cached != null) return cached.percent;
    throw err;
  }
}

/** Drop the cached fee percents (after a Stripe settings or site payment config change). */
export function clearPlatformFeeCache(): void {
  cache.clear();
}

const WEBHOOK_SECRET_KEY = 'stripe.webhookSecretEnc';
let webhookSecretCache: { secret: string | null; cachedAt: number } | null = null;

/**
 * The Stripe webhook signing secret (`stripe.webhookSecretEnc`, decrypted with
 * the caller's SETTINGS_ENCRYPTION_KEY), or null when it is not set. Cached
 * for 60 seconds. A read or decrypt failure throws: the webhook must not be
 * accepted without verifying its signature.
 */
export async function getStripeWebhookSecret(encryptionKey: string): Promise<string | null> {
  const now = Date.now();
  if (webhookSecretCache != null && now - webhookSecretCache.cachedAt < TTL_MS) {
    return webhookSecretCache.secret;
  }
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, WEBHOOK_SECRET_KEY));
  const stored = row?.value;
  const secret =
    typeof stored === 'string' && stored !== '' ? decryptString(stored, encryptionKey) : null;
  webhookSecretCache = { secret, cachedAt: now };
  return secret;
}

/** Drop the cached webhook signing secret (after a Stripe settings change). */
export function clearStripeWebhookSecretCache(): void {
  webhookSecretCache = null;
}
