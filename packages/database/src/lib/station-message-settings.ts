// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const TTL_MS = 60_000;

let cachedEnabled: boolean | undefined;
let cachedEnabledAt = 0;

let cachedPricingFormat: string | undefined;
let cachedPricingFormatAt = 0;

let cachedRefreshSeconds: number | undefined;
let cachedRefreshSecondsAt = 0;

let cachedEventMessageTtl: number | undefined;
let cachedEventMessageTtlAt = 0;

let cachedBrandLine: string | undefined;
let cachedBrandLineAt = 0;

export async function isStationMessageEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedEnabled !== undefined && now - cachedEnabledAt < TTL_MS) {
    return cachedEnabled;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'stationMessage.enabled'));

    cachedEnabled = row != null && row.value === true;
    cachedEnabledAt = now;
    return cachedEnabled;
  } catch {
    return cachedEnabled ?? false;
  }
}

export async function getStationMessagePricingFormat(): Promise<string> {
  const now = Date.now();
  if (cachedPricingFormat !== undefined && now - cachedPricingFormatAt < TTL_MS) {
    return cachedPricingFormat;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'stationMessage.pricingFormat'));

    cachedPricingFormat = row != null && typeof row.value === 'string' ? row.value : 'compact';
    cachedPricingFormatAt = now;
    return cachedPricingFormat;
  } catch {
    return cachedPricingFormat ?? 'compact';
  }
}

export async function getStationMessageRefreshSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedRefreshSeconds !== undefined && now - cachedRefreshSecondsAt < TTL_MS) {
    return cachedRefreshSeconds;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'stationMessage.charging.refreshSeconds'));

    const value = row?.value;
    cachedRefreshSeconds = typeof value === 'number' ? value : 30;
    cachedRefreshSecondsAt = now;
    return cachedRefreshSeconds;
  } catch {
    return cachedRefreshSeconds ?? 30;
  }
}

// TTL in seconds for one-shot event-driven station messages (payment failure,
// authorization required, etc.). Used as the SetDisplayMessage endDateTime
// offset on OCPP 2.1 (station auto-clears) AND as the autoClearMs delay for
// the defensive ClearDisplayMessage / DataTransfer-clear that the dispatcher
// schedules in-process so 1.6 stations and any 2.1 station that ignores
// endDateTime still get a clear.
export async function getStationMessageEventTtlSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedEventMessageTtl !== undefined && now - cachedEventMessageTtlAt < TTL_MS) {
    return cachedEventMessageTtl;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'stationMessage.eventMessageTtlSeconds'));

    const value = row?.value;
    cachedEventMessageTtl = typeof value === 'number' && value > 0 ? value : 30;
    cachedEventMessageTtlAt = now;
    return cachedEventMessageTtl;
  } catch {
    return cachedEventMessageTtl ?? 30;
  }
}

export async function getStationMessageBrandLine(): Promise<string> {
  const now = Date.now();
  if (cachedBrandLine !== undefined && now - cachedBrandLineAt < TTL_MS) {
    return cachedBrandLine;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'stationMessage.brandLine'));

    cachedBrandLine = row != null && typeof row.value === 'string' ? row.value : '';
    cachedBrandLineAt = now;
    return cachedBrandLine;
  } catch {
    return cachedBrandLine ?? '';
  }
}

export function clearStationMessageSettingsCache(): void {
  cachedEnabled = undefined;
  cachedEnabledAt = 0;
  cachedPricingFormat = undefined;
  cachedPricingFormatAt = 0;
  cachedRefreshSeconds = undefined;
  cachedRefreshSecondsAt = 0;
  cachedEventMessageTtl = undefined;
  cachedEventMessageTtlAt = 0;
  cachedBrandLine = undefined;
  cachedBrandLineAt = 0;
}
