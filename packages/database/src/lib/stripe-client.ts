// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { decryptString } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

/**
 * The platform Stripe client for processes other than the API (OCPP session
 * pre-auth and capture, the worker's shortfall retry). Built from the
 * `stripe.secretKeyEnc` setting, decrypted with the caller's
 * SETTINGS_ENCRYPTION_KEY (each process passes its own config value), and
 * cached for 60 seconds so a charging start does not read and decrypt the
 * key and build a new client every time (design principle P6).
 *
 * Retries 429s and transient network errors 3 times with backoff, as the
 * API's client does.
 *
 * Returns null when no secret key is set. A read or decrypt failure throws:
 * a payment must not proceed without the configured key.
 */
const TTL_MS = 60_000;
let cache: { client: Stripe | null; cachedAt: number } | null = null;

export async function getStripeClient(encryptionKey: string): Promise<Stripe | null> {
  const now = Date.now();
  if (cache != null && now - cache.cachedAt < TTL_MS) return cache.client;

  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'stripe.secretKeyEnc'));
  const stored = row?.value;
  const client =
    typeof stored === 'string' && stored !== ''
      ? new Stripe(decryptString(stored, encryptionKey), { maxNetworkRetries: 3 })
      : null;
  cache = { client, cachedAt: now };
  return client;
}

/** Drop the cached client (after a Stripe settings change in this process). */
export function clearStripeClientCache(): void {
  cache = null;
}
