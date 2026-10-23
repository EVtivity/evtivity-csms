// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, inArray } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import {
  DATA_PLAN_DEFAULTS,
  createLogger,
  dataPlanSettingKeys,
  dataPlanValuesFromSettings,
} from '@evtivity/lib';
import type { DataPlan, DataPlanValues } from '@evtivity/lib';

const logger = createLogger('ocpp-settings');

let cachedOfflineTtl: number | undefined;
let cachedOfflineTtlAt = 0;

/** How long each process caches the ocpp.* and smartCharging.* settings it reads. */
export const OCPP_SETTINGS_CACHE_TTL_MS = 60_000;

export async function getOfflineCommandTtlHours(): Promise<number> {
  const now = Date.now();
  if (cachedOfflineTtl !== undefined && now - cachedOfflineTtlAt < OCPP_SETTINGS_CACHE_TTL_MS) {
    return cachedOfflineTtl;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.offlineCommandTtlHours'));

    cachedOfflineTtl = row != null && typeof row.value === 'number' ? row.value : 24;
    cachedOfflineTtlAt = now;
    return cachedOfflineTtl;
  } catch (err) {
    logger.warn(
      { err, key: 'ocpp.offlineCommandTtlHours' },
      'getOfflineCommandTtlHours failed, using the cached value or default',
    );
    return cachedOfflineTtl ?? 24;
  }
}

// --- Data plan values ---

const cachedPlanValues = new Map<DataPlan, { values: DataPlanValues; at: number }>();

/**
 * The OCPP station settings of a data plan (heartbeat, CSMS ping, idle and end
 * readings, AC and DC readings while charging), read in one query and cached
 * per plan. A missing or wrongly typed key takes its shipped value; a failed
 * read keeps the cached values, else the shipped ones.
 */
export async function getDataPlanValues(plan: DataPlan): Promise<DataPlanValues> {
  const now = Date.now();
  const cached = cachedPlanValues.get(plan);
  if (cached != null && now - cached.at < OCPP_SETTINGS_CACHE_TTL_MS) return cached.values;

  const keys = Object.values(dataPlanSettingKeys(plan));
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, keys));
    const values = dataPlanValuesFromSettings(plan, new Map(rows.map((r) => [r.key, r.value])));
    cachedPlanValues.set(plan, { values, at: now });
    return values;
  } catch (err) {
    logger.warn(
      { err, plan },
      'getDataPlanValues failed, using the cached values or the shipped values',
    );
    return cached?.values ?? DATA_PLAN_DEFAULTS[plan];
  }
}

/** Drops the cached data plan values (tests, and after a settings write in this process). */
export function clearDataPlanValuesCache(): void {
  cachedPlanValues.clear();
}

// --- Command Retry Settings ---

let cachedRetryMaxAttempts: number | undefined;
let cachedRetryMaxAttemptsAt = 0;

let cachedRetryBaseDelayMs: number | undefined;
let cachedRetryBaseDelayMsAt = 0;

let cachedRetryMaxDelayMs: number | undefined;
let cachedRetryMaxDelayMsAt = 0;

export async function getCommandRetryMaxAttempts(): Promise<number> {
  const now = Date.now();
  if (
    cachedRetryMaxAttempts !== undefined &&
    now - cachedRetryMaxAttemptsAt < OCPP_SETTINGS_CACHE_TTL_MS
  ) {
    return cachedRetryMaxAttempts;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.commandRetryMaxAttempts'));

    cachedRetryMaxAttempts = row != null && typeof row.value === 'number' ? row.value : 3;
    cachedRetryMaxAttemptsAt = now;
    return cachedRetryMaxAttempts;
  } catch (err) {
    logger.warn(
      { err, key: 'ocpp.commandRetryMaxAttempts' },
      'getCommandRetryMaxAttempts failed, using the cached value or default',
    );
    return cachedRetryMaxAttempts ?? 3;
  }
}

export async function getCommandRetryBaseDelayMs(): Promise<number> {
  const now = Date.now();
  if (
    cachedRetryBaseDelayMs !== undefined &&
    now - cachedRetryBaseDelayMsAt < OCPP_SETTINGS_CACHE_TTL_MS
  ) {
    return cachedRetryBaseDelayMs;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.commandRetryBaseDelayMs'));

    cachedRetryBaseDelayMs = row != null && typeof row.value === 'number' ? row.value : 1000;
    cachedRetryBaseDelayMsAt = now;
    return cachedRetryBaseDelayMs;
  } catch (err) {
    logger.warn(
      { err, key: 'ocpp.commandRetryBaseDelayMs' },
      'getCommandRetryBaseDelayMs failed, using the cached value or default',
    );
    return cachedRetryBaseDelayMs ?? 1000;
  }
}

export async function getCommandRetryMaxDelayMs(): Promise<number> {
  const now = Date.now();
  if (
    cachedRetryMaxDelayMs !== undefined &&
    now - cachedRetryMaxDelayMsAt < OCPP_SETTINGS_CACHE_TTL_MS
  ) {
    return cachedRetryMaxDelayMs;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.commandRetryMaxDelayMs'));

    cachedRetryMaxDelayMs = row != null && typeof row.value === 'number' ? row.value : 30000;
    cachedRetryMaxDelayMsAt = now;
    return cachedRetryMaxDelayMs;
  } catch (err) {
    logger.warn(
      { err, key: 'ocpp.commandRetryMaxDelayMs' },
      'getCommandRetryMaxDelayMs failed, using the cached value or default',
    );
    return cachedRetryMaxDelayMs ?? 30000;
  }
}

// --- Smart Charging Settings ---

let cachedIso15118Enabled: boolean | undefined;
let cachedIso15118EnabledAt = 0;

let cachedDefaultMaxPowerW: number | undefined;
let cachedDefaultMaxPowerWAt = 0;

export async function isIso15118Enabled(): Promise<boolean> {
  const now = Date.now();
  if (
    cachedIso15118Enabled !== undefined &&
    now - cachedIso15118EnabledAt < OCPP_SETTINGS_CACHE_TTL_MS
  ) {
    return cachedIso15118Enabled;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'smartCharging.iso15118Enabled'));

    cachedIso15118Enabled = row != null && typeof row.value === 'boolean' ? row.value : true;
    cachedIso15118EnabledAt = now;
    return cachedIso15118Enabled;
  } catch (err) {
    logger.warn(
      { err, key: 'smartCharging.iso15118Enabled' },
      'isIso15118Enabled failed, using the cached value or default',
    );
    return cachedIso15118Enabled ?? true;
  }
}

export async function getDefaultMaxPowerW(): Promise<number> {
  const now = Date.now();
  if (
    cachedDefaultMaxPowerW !== undefined &&
    now - cachedDefaultMaxPowerWAt < OCPP_SETTINGS_CACHE_TTL_MS
  ) {
    return cachedDefaultMaxPowerW;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'smartCharging.defaultMaxPowerW'));

    cachedDefaultMaxPowerW = row != null && typeof row.value === 'number' ? row.value : 22000;
    cachedDefaultMaxPowerWAt = now;
    return cachedDefaultMaxPowerW;
  } catch (err) {
    logger.warn(
      { err, key: 'smartCharging.defaultMaxPowerW' },
      'getDefaultMaxPowerW failed, using the cached value or default',
    );
    return cachedDefaultMaxPowerW ?? 22000;
  }
}
