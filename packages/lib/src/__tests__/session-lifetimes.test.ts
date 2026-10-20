// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SESSION_LIFETIMES,
  SESSION_LIFETIME_LIMITS,
  normalizeSessionLifetimes,
} from '../session-lifetimes.js';

describe('session lifetimes', () => {
  it('defaults to a 60 minute access token and 30 day refresh for operators and drivers', () => {
    expect(DEFAULT_SESSION_LIFETIMES).toEqual({
      operatorAccessMinutes: 60,
      operatorRefreshDays: 30,
      driverAccessMinutes: 60,
      driverRefreshDays: 30,
    });
  });

  it('has the documented ranges', () => {
    expect(SESSION_LIFETIME_LIMITS).toEqual({
      operatorAccessMinutes: { min: 5, max: 1440 },
      operatorRefreshDays: { min: 1, max: 90 },
      driverAccessMinutes: { min: 5, max: 1440 },
      driverRefreshDays: { min: 1, max: 365 },
    });
  });

  it('keeps stored values in range', () => {
    expect(
      normalizeSessionLifetimes({
        operatorAccessMinutes: 15,
        operatorRefreshDays: 7,
        driverAccessMinutes: 120,
        driverRefreshDays: 365,
      }),
    ).toEqual({
      operatorAccessMinutes: 15,
      operatorRefreshDays: 7,
      driverAccessMinutes: 120,
      driverRefreshDays: 365,
    });
  });

  it('clamps out of range values to the nearest limit', () => {
    expect(
      normalizeSessionLifetimes({
        operatorAccessMinutes: 1,
        operatorRefreshDays: 400,
        driverAccessMinutes: 5000,
        driverRefreshDays: 0,
      }),
    ).toEqual({
      operatorAccessMinutes: 5,
      operatorRefreshDays: 90,
      driverAccessMinutes: 1440,
      driverRefreshDays: 1,
    });
  });

  it('falls back to the default per field for a missing or mistyped value', () => {
    expect(
      normalizeSessionLifetimes({
        operatorAccessMinutes: '30',
        driverRefreshDays: Number.POSITIVE_INFINITY,
        driverAccessMinutes: 45.9,
      }),
    ).toEqual({ ...DEFAULT_SESSION_LIFETIMES, driverAccessMinutes: 45 });
  });
});
