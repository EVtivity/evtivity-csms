// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('pricing-settings');

let cachedSplitBilling: boolean | undefined;
let cachedSplitBillingAt = 0;
const TTL_MS = 60_000;

export async function isSplitBillingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedSplitBilling !== undefined && now - cachedSplitBillingAt < TTL_MS) {
    return cachedSplitBilling;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'pricing.splitBillingEnabled'));

    cachedSplitBilling = row == null || row.value === true;
    cachedSplitBillingAt = now;
    return cachedSplitBilling;
  } catch (err) {
    logger.warn(
      { err, key: 'pricing.splitBillingEnabled' },
      'isSplitBillingEnabled failed, using the cached value or default',
    );
    return cachedSplitBilling ?? true;
  }
}

export function clearPricingSettingsCache(): void {
  cachedSplitBilling = undefined;
  cachedSplitBillingAt = 0;
}
