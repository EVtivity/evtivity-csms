// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inArray } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

export interface ReservationSettings {
  enabled: boolean;
  bufferMinutes: number;
  cancellationWindowMinutes: number;
  cancellationFeeCents: number;
  maxHours: number;
  /**
   * When creating a reservation whose start time falls within this many hours
   * of "now", reject if the targeted EVSE has an active charging session. We
   * cannot predict when an in-flight session will end, so a near-future
   * reservation against a busy EVSE will fail at the station with `Occupied`.
   * Reservations scheduled further out are allowed; the worker re-validates at
   * activation time. Set to 0 to disable the check entirely.
   */
  activeSessionCheckHours: number;
}

const RESERVATION_KEYS = [
  'reservation.enabled',
  'reservation.bufferMinutes',
  'reservation.cancellationWindowMinutes',
  'reservation.cancellationFeeCents',
  'reservation.maxHours',
  'reservation.activeSessionCheckHours',
] as const;

const DEFAULTS: ReservationSettings = {
  enabled: true,
  bufferMinutes: 0,
  cancellationWindowMinutes: 0,
  cancellationFeeCents: 0,
  maxHours: 3,
  activeSessionCheckHours: 3,
};

let cache: ReservationSettings | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getReservationSettings(): Promise<ReservationSettings> {
  const now = Date.now();
  if (cache !== undefined && now - cachedAt < TTL_MS) {
    return cache;
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [...RESERVATION_KEYS]));

    const map = new Map<string, unknown>();
    for (const row of rows) {
      map.set(row.key, row.value);
    }

    cache = {
      enabled: map.get('reservation.enabled') !== false,
      bufferMinutes: map.has('reservation.bufferMinutes')
        ? Number(map.get('reservation.bufferMinutes'))
        : DEFAULTS.bufferMinutes,
      cancellationWindowMinutes: map.has('reservation.cancellationWindowMinutes')
        ? Number(map.get('reservation.cancellationWindowMinutes'))
        : DEFAULTS.cancellationWindowMinutes,
      cancellationFeeCents: map.has('reservation.cancellationFeeCents')
        ? Number(map.get('reservation.cancellationFeeCents'))
        : DEFAULTS.cancellationFeeCents,
      maxHours: map.has('reservation.maxHours')
        ? Number(map.get('reservation.maxHours'))
        : DEFAULTS.maxHours,
      activeSessionCheckHours: map.has('reservation.activeSessionCheckHours')
        ? Number(map.get('reservation.activeSessionCheckHours'))
        : DEFAULTS.activeSessionCheckHours,
    };
    cachedAt = now;
    return cache;
  } catch {
    return cache ?? { ...DEFAULTS };
  }
}

export async function isReservationEnabled(): Promise<boolean> {
  const s = await getReservationSettings();
  return s.enabled;
}

export function invalidateReservationSettingsCache(): void {
  cache = undefined;
  cachedAt = 0;
}
