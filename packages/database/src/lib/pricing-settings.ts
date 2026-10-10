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

/**
 * Cached reader (60 s) for `pricing.splitBillingEnabled`. On by default (the
 * shipped default, owner decision 2026-10-09): off only when the stored value
 * is the boolean false. A missing row (an install that skipped the seed), an
 * invalid value (logged at warn), or a failed read without a cached value
 * means on.
 */
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

    // On unless the stored value is the boolean false: a missing row or an
    // invalid value means the shipped default, on.
    if (row != null && typeof row.value !== 'boolean') {
      logger.warn(
        { key: 'pricing.splitBillingEnabled', value: row.value },
        'Invalid split billing setting, using the default (on)',
      );
    }
    cachedSplitBilling = row?.value !== false;
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
