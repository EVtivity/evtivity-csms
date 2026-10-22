// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * SIM provider and station signal settings: names, ranges and defaults.
 * Browser-safe, so the CSMS settings form imports them via `@evtivity/lib/sim-settings`.
 */

export const SIM_SETTING_KEYS = Object.freeze({
  hologramEnabled: 'sim.hologram.enabled',
  hologramOrgId: 'sim.hologram.orgId',
  hologramApiKeyEnc: 'sim.hologram.apiKeyEnc',
  retentionDays: 'sim.sessions.retentionDays',
  fetchDays: 'sim.sessions.fetchDays',
  stationSignalEnabled: 'sim.stationSignal.enabled',
  signalAlertBelowDbm: 'sim.signal.alertBelowDbm',
  ocpp16SignalKeys: 'sim.ocpp16.signalKeys',
  signalGoodDbm: 'sim.signal.goodDbm',
  signalFairDbm: 'sim.signal.fairDbm',
});

export const SIM_SETTING_KEY_LIST: readonly string[] = Object.freeze(
  Object.values(SIM_SETTING_KEYS),
);

/** Hologram organization ids are digits only, at most this many (the Helm chart and CDK check the same). */
export const SIM_HOLOGRAM_ORG_ID_MAX_DIGITS = 15;

const HOLOGRAM_ORG_ID = new RegExp(`^\\d{1,${String(SIM_HOLOGRAM_ORG_ID_MAX_DIGITS)}}$`);

/** A Hologram organization id: 1 to 15 digits after trimming (it is also sent in the query). */
export function isHologramOrgId(value: string): boolean {
  return HOLOGRAM_ORG_ID.test(value.trim());
}

/** Days sessions and SIM alerts are kept. */
export const SIM_RETENTION_DAYS = Object.freeze({ min: 7, max: 730, default: 90 });

/** The Refresh period preselected on the Connectivity tab. */
export const SIM_FETCH_DAYS = Object.freeze({ min: 1, max: 31, default: 7 });

/** The periods a Refresh offers, in days. */
export const SIM_REFRESH_DAY_OPTIONS: readonly number[] = Object.freeze([1, 3, 7, 14, 31]);

/** The longest date range one Refresh fetches. */
export const SIM_RANGE_MAX_DAYS = 31;

/** Signal thresholds in dBm. */
export const SIM_SIGNAL_DBM = Object.freeze({ min: -140, max: -40 });

export const SIM_SIGNAL_DEFAULTS = Object.freeze({ goodDbm: -65, fairDbm: -85 });

/** OCPP 1.6 configuration keys read for the station signal (CiString50 each). */
export const SIM_OCPP16_SIGNAL_KEYS_LIMITS = Object.freeze({ maxKeys: 20, maxLength: 50 });

export interface SimGeneralSettings {
  retentionDays: number;
  fetchDays: number;
  stationSignalEnabled: boolean;
  /** Null when the low signal alert is off. */
  signalAlertBelowDbm: number | null;
  ocpp16SignalKeys: string[];
  signalGoodDbm: number;
  signalFairDbm: number;
}

function intInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

export function isSimRetentionDays(value: unknown): value is number {
  return intInRange(value, SIM_RETENTION_DAYS.min, SIM_RETENTION_DAYS.max) != null;
}

export function isSimFetchDays(value: unknown): value is number {
  return intInRange(value, SIM_FETCH_DAYS.min, SIM_FETCH_DAYS.max) != null;
}

export function isSimSignalDbm(value: unknown): value is number {
  return intInRange(value, SIM_SIGNAL_DBM.min, SIM_SIGNAL_DBM.max) != null;
}

/**
 * The 1.6 key list as stored: trimmed, without empty or repeated names. Null
 * when the input is not a list of strings or breaks the limits.
 */
export function parseOcpp16SignalKeys(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const key = item.trim();
    if (key === '') continue;
    if (key.length > SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxLength) return null;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.length > SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxKeys ? null : keys;
}

/**
 * Settings from stored values: a missing, mistyped or out of range value takes
 * its default; thresholds that are not ordered (good above fair) take both
 * defaults. An empty or null low signal alert is off.
 */
export function normalizeSimGeneralSettings(raw: Record<string, unknown>): SimGeneralSettings {
  const good = intInRange(
    raw[SIM_SETTING_KEYS.signalGoodDbm],
    SIM_SIGNAL_DBM.min,
    SIM_SIGNAL_DBM.max,
  );
  const fair = intInRange(
    raw[SIM_SETTING_KEYS.signalFairDbm],
    SIM_SIGNAL_DBM.min,
    SIM_SIGNAL_DBM.max,
  );
  const ordered = (good ?? SIM_SIGNAL_DEFAULTS.goodDbm) > (fair ?? SIM_SIGNAL_DEFAULTS.fairDbm);
  return {
    retentionDays:
      intInRange(
        raw[SIM_SETTING_KEYS.retentionDays],
        SIM_RETENTION_DAYS.min,
        SIM_RETENTION_DAYS.max,
      ) ?? SIM_RETENTION_DAYS.default,
    fetchDays:
      intInRange(raw[SIM_SETTING_KEYS.fetchDays], SIM_FETCH_DAYS.min, SIM_FETCH_DAYS.max) ??
      SIM_FETCH_DAYS.default,
    stationSignalEnabled: raw[SIM_SETTING_KEYS.stationSignalEnabled] === true,
    signalAlertBelowDbm: intInRange(
      raw[SIM_SETTING_KEYS.signalAlertBelowDbm],
      SIM_SIGNAL_DBM.min,
      SIM_SIGNAL_DBM.max,
    ),
    ocpp16SignalKeys: parseOcpp16SignalKeys(raw[SIM_SETTING_KEYS.ocpp16SignalKeys]) ?? [],
    signalGoodDbm: ordered ? (good ?? SIM_SIGNAL_DEFAULTS.goodDbm) : SIM_SIGNAL_DEFAULTS.goodDbm,
    signalFairDbm: ordered ? (fair ?? SIM_SIGNAL_DEFAULTS.fairDbm) : SIM_SIGNAL_DEFAULTS.fairDbm,
  };
}
