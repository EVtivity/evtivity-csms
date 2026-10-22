// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import {
  createLogger,
  decryptSettingOrNull,
  normalizeSimGeneralSettings,
  SIM_SETTING_KEYS,
  type SimGeneralSettings,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('sim-settings');

/** Same shape as the Hologram settings of `@evtivity/sim-providers`. */
export interface SimHologramSettings {
  enabled: boolean;
  apiKey: string;
  orgId: string;
}

/**
 * The SIM settings with the provider secrets decrypted. `hologram` matches the
 * provider settings a SIM provider registry builds its adapters from.
 */
export interface SimSettings extends SimGeneralSettings {
  hologram: SimHologramSettings;
}

const SIM_SETTINGS_CACHE_TTL_MS = 60_000;

let cached: { value: SimSettings; at: number } | undefined;

// The jsonb reader turns a stored string of digits (an organization id) into a number.
function stringValue(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function decryptedApiKey(value: unknown, encryptionKey: string): string {
  try {
    return (decryptSettingOrNull(value, encryptionKey) ?? '').trim();
  } catch (err: unknown) {
    logger.warn(
      { err, key: SIM_SETTING_KEYS.hologramApiKeyEnc },
      'SIM provider API key decryption failed, Hologram has no API key',
    );
    return '';
  }
}

export function parseSimSettings(
  rows: readonly { key: string; value: unknown }[],
  encryptionKey: string,
): SimSettings {
  const map: Record<string, unknown> = {};
  for (const row of rows) map[row.key] = row.value;
  return {
    ...normalizeSimGeneralSettings(map),
    hologram: {
      enabled: map[SIM_SETTING_KEYS.hologramEnabled] === true,
      apiKey: decryptedApiKey(map[SIM_SETTING_KEYS.hologramApiKeyEnc], encryptionKey),
      orgId: stringValue(map[SIM_SETTING_KEYS.hologramOrgId]),
    },
  };
}

function defaultSimSettings(): SimSettings {
  return {
    ...normalizeSimGeneralSettings({}),
    hologram: { enabled: false, apiKey: '', orgId: '' },
  };
}

/**
 * The SIM settings (`sim.*`), read once a minute per process. A failed read
 * keeps the last value, or the defaults (every provider and station signal
 * reads off) when there is none.
 */
export async function getSimProviderSettings(encryptionKey: string): Promise<SimSettings> {
  const now = Date.now();
  if (cached != null && now - cached.at < SIM_SETTINGS_CACHE_TTL_MS) return cached.value;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'sim.%'));
    const value = parseSimSettings(rows, encryptionKey);
    cached = { value, at: now };
    return value;
  } catch (err: unknown) {
    logger.warn({ err }, 'SIM settings read failed, using the cached value or the defaults');
    return cached?.value ?? defaultSimSettings();
  }
}

let cachedGeneral: { value: SimGeneralSettings; at: number } | undefined;

/**
 * The SIM settings without the provider secrets (station signal reads and the
 * signal thresholds), for a process that never calls a provider (OCPP). Read
 * once a minute per process; a failed read keeps the last value or the
 * defaults (station signal reads off).
 */
export async function getSimGeneralSettings(): Promise<SimGeneralSettings> {
  const now = Date.now();
  if (cachedGeneral != null && now - cachedGeneral.at < SIM_SETTINGS_CACHE_TTL_MS) {
    return cachedGeneral.value;
  }
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'sim.%'));
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key] = row.value;
    const value = normalizeSimGeneralSettings(map);
    cachedGeneral = { value, at: now };
    return value;
  } catch (err: unknown) {
    logger.warn({ err }, 'SIM settings read failed, using the cached value or the defaults');
    return cachedGeneral?.value ?? normalizeSimGeneralSettings({});
  }
}

/** Call after a SIM settings write so the next read sees it. */
export function clearSimSettingsCache(): void {
  cached = undefined;
  cachedGeneral = undefined;
}
