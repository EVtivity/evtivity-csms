// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

let cachedSplitBilling: boolean | undefined;
let cachedSplitBillingAt = 0;
let cachedDisplayFormat: string | undefined;
let cachedDisplayFormatAt = 0;
let cachedPushDisplay: boolean | undefined;
let cachedPushDisplayAt = 0;
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
  } catch {
    return cachedSplitBilling ?? true;
  }
}

export async function getPricingDisplayFormat(): Promise<string> {
  const now = Date.now();
  if (cachedDisplayFormat !== undefined && now - cachedDisplayFormatAt < TTL_MS) {
    return cachedDisplayFormat;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'pricing.displayFormat'));

    cachedDisplayFormat = row != null && typeof row.value === 'string' ? row.value : 'standard';
    cachedDisplayFormatAt = now;
    return cachedDisplayFormat;
  } catch {
    return cachedDisplayFormat ?? 'standard';
  }
}

export async function isPushDisplayEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedPushDisplay !== undefined && now - cachedPushDisplayAt < TTL_MS) {
    return cachedPushDisplay;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'pricing.pushDisplayEnabled'));

    cachedPushDisplay = row == null || row.value === true;
    cachedPushDisplayAt = now;
    return cachedPushDisplay;
  } catch {
    return cachedPushDisplay ?? true;
  }
}

export function clearPricingSettingsCache(): void {
  cachedSplitBilling = undefined;
  cachedSplitBillingAt = 0;
  cachedDisplayFormat = undefined;
  cachedDisplayFormatAt = 0;
  cachedPushDisplay = undefined;
  cachedPushDisplayAt = 0;
}
