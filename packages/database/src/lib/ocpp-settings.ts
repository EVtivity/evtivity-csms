// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

let cachedHeartbeat: number | undefined;
let cachedHeartbeatAt = 0;

let cachedOfflineTtl: number | undefined;
let cachedOfflineTtlAt = 0;

const TTL_MS = 60_000;

export async function getHeartbeatIntervalSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedHeartbeat !== undefined && now - cachedHeartbeatAt < TTL_MS) {
    return cachedHeartbeat;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.heartbeatInterval'));

    cachedHeartbeat = row != null && typeof row.value === 'number' ? row.value : 300;
    cachedHeartbeatAt = now;
    return cachedHeartbeat;
  } catch {
    return cachedHeartbeat ?? 300;
  }
}

export async function getOfflineCommandTtlHours(): Promise<number> {
  const now = Date.now();
  if (cachedOfflineTtl !== undefined && now - cachedOfflineTtlAt < TTL_MS) {
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
  } catch {
    return cachedOfflineTtl ?? 24;
  }
}

// --- Meter Value Interval ---

let cachedMeterValueInterval: number | undefined;
let cachedMeterValueIntervalAt = 0;

export async function getMeterValueIntervalSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedMeterValueInterval !== undefined && now - cachedMeterValueIntervalAt < TTL_MS) {
    return cachedMeterValueInterval;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.meterValueInterval'));

    cachedMeterValueInterval = row != null && typeof row.value === 'number' ? row.value : 60;
    cachedMeterValueIntervalAt = now;
    return cachedMeterValueInterval;
  } catch {
    return cachedMeterValueInterval ?? 60;
  }
}

// --- Clock-Aligned Interval ---

let cachedClockAlignedInterval: number | undefined;
let cachedClockAlignedIntervalAt = 0;

export async function getClockAlignedIntervalSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedClockAlignedInterval !== undefined && now - cachedClockAlignedIntervalAt < TTL_MS) {
    return cachedClockAlignedInterval;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.clockAlignedInterval'));

    cachedClockAlignedInterval = row != null && typeof row.value === 'number' ? row.value : 60;
    cachedClockAlignedIntervalAt = now;
    return cachedClockAlignedInterval;
  } catch {
    return cachedClockAlignedInterval ?? 60;
  }
}

// --- Measurand Settings ---

let cachedSampledMeasurands: string | undefined;
let cachedSampledMeasurandsAt = 0;

let cachedAlignedMeasurands: string | undefined;
let cachedAlignedMeasurandsAt = 0;

let cachedTxEndedMeasurands: string | undefined;
let cachedTxEndedMeasurandsAt = 0;

const DEFAULT_SAMPLED_MEASURANDS =
  'Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import';
const DEFAULT_ALIGNED_MEASURANDS =
  'Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import';
const DEFAULT_TX_ENDED_MEASURANDS = 'Energy.Active.Import.Register';

export async function getSampledMeasurands(): Promise<string> {
  const now = Date.now();
  if (cachedSampledMeasurands !== undefined && now - cachedSampledMeasurandsAt < TTL_MS) {
    return cachedSampledMeasurands;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.sampledMeasurands'));

    cachedSampledMeasurands =
      row != null && typeof row.value === 'string' ? row.value : DEFAULT_SAMPLED_MEASURANDS;
    cachedSampledMeasurandsAt = now;
    return cachedSampledMeasurands;
  } catch {
    return cachedSampledMeasurands ?? DEFAULT_SAMPLED_MEASURANDS;
  }
}

export async function getAlignedMeasurands(): Promise<string> {
  const now = Date.now();
  if (cachedAlignedMeasurands !== undefined && now - cachedAlignedMeasurandsAt < TTL_MS) {
    return cachedAlignedMeasurands;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.alignedMeasurands'));

    cachedAlignedMeasurands =
      row != null && typeof row.value === 'string' ? row.value : DEFAULT_ALIGNED_MEASURANDS;
    cachedAlignedMeasurandsAt = now;
    return cachedAlignedMeasurands;
  } catch {
    return cachedAlignedMeasurands ?? DEFAULT_ALIGNED_MEASURANDS;
  }
}

export async function getTxEndedMeasurands(): Promise<string> {
  const now = Date.now();
  if (cachedTxEndedMeasurands !== undefined && now - cachedTxEndedMeasurandsAt < TTL_MS) {
    return cachedTxEndedMeasurands;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.txEndedMeasurands'));

    cachedTxEndedMeasurands =
      row != null && typeof row.value === 'string' ? row.value : DEFAULT_TX_ENDED_MEASURANDS;
    cachedTxEndedMeasurandsAt = now;
    return cachedTxEndedMeasurands;
  } catch {
    return cachedTxEndedMeasurands ?? DEFAULT_TX_ENDED_MEASURANDS;
  }
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
  if (cachedRetryMaxAttempts !== undefined && now - cachedRetryMaxAttemptsAt < TTL_MS) {
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
  } catch {
    return cachedRetryMaxAttempts ?? 3;
  }
}

export async function getCommandRetryBaseDelayMs(): Promise<number> {
  const now = Date.now();
  if (cachedRetryBaseDelayMs !== undefined && now - cachedRetryBaseDelayMsAt < TTL_MS) {
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
  } catch {
    return cachedRetryBaseDelayMs ?? 1000;
  }
}

export async function getCommandRetryMaxDelayMs(): Promise<number> {
  const now = Date.now();
  if (cachedRetryMaxDelayMs !== undefined && now - cachedRetryMaxDelayMsAt < TTL_MS) {
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
  } catch {
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
  if (cachedIso15118Enabled !== undefined && now - cachedIso15118EnabledAt < TTL_MS) {
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
  } catch {
    return cachedIso15118Enabled ?? true;
  }
}

export async function getDefaultMaxPowerW(): Promise<number> {
  const now = Date.now();
  if (cachedDefaultMaxPowerW !== undefined && now - cachedDefaultMaxPowerWAt < TTL_MS) {
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
  } catch {
    return cachedDefaultMaxPowerW ?? 22000;
  }
}
