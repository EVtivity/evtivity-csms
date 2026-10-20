// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Access and refresh token lifetimes for operators and drivers, set in Settings > Security.
 * Browser-safe, so the CSMS settings form imports the ranges via `@evtivity/lib/session-lifetimes`.
 */

export interface SessionLifetimes {
  operatorAccessMinutes: number;
  operatorRefreshDays: number;
  driverAccessMinutes: number;
  driverRefreshDays: number;
}

export const SESSION_LIFETIME_LIMITS: Readonly<
  Record<keyof SessionLifetimes, Readonly<{ min: number; max: number }>>
> = Object.freeze({
  operatorAccessMinutes: Object.freeze({ min: 5, max: 1440 }),
  operatorRefreshDays: Object.freeze({ min: 1, max: 90 }),
  driverAccessMinutes: Object.freeze({ min: 5, max: 1440 }),
  driverRefreshDays: Object.freeze({ min: 1, max: 365 }),
});

export const DEFAULT_SESSION_LIFETIMES: Readonly<SessionLifetimes> = Object.freeze({
  operatorAccessMinutes: 60,
  operatorRefreshDays: 30,
  driverAccessMinutes: 60,
  driverRefreshDays: 30,
});

const FIELDS = Object.keys(DEFAULT_SESSION_LIFETIMES) as (keyof SessionLifetimes)[];

/**
 * Lifetimes from stored values: a missing or non-numeric field takes its default, and every
 * value is truncated to an integer and clamped to its range.
 */
export function normalizeSessionLifetimes(raw: Record<string, unknown>): SessionLifetimes {
  const result = { ...DEFAULT_SESSION_LIFETIMES };
  for (const field of FIELDS) {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = SESSION_LIFETIME_LIMITS[field];
    result[field] = Math.min(max, Math.max(min, Math.trunc(value)));
  }
  return result;
}
