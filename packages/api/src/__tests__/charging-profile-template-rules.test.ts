// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { templateStateError } from '../lib/charging-profile-template-rules.js';
import type { TemplateState } from '../lib/charging-profile-template-rules.js';

const valid: TemplateState = {
  ocppVersion: '2.1',
  profilePurpose: 'ChargingStationMaxProfile',
  profileKind: 'Absolute',
  recurrencyKind: null,
  schedulePeriods: [
    { startPeriod: 0, limit: 11000 },
    { startPeriod: 3600, limit: 7000 },
  ],
  startSchedule: '2026-10-13T00:00:00.000Z',
  validFrom: null,
  validTo: null,
};

describe('templateStateError', () => {
  it('accepts a valid template', () => {
    expect(templateStateError(valid)).toBeNull();
    expect(
      templateStateError({ ...valid, profileKind: 'Recurring', recurrencyKind: 'Daily' }),
    ).toBeNull();
  });

  it('refuses a purpose OCPP 1.6 does not have', () => {
    expect(
      templateStateError({ ...valid, ocppVersion: '1.6', profilePurpose: 'PriorityCharging' }),
    ).toMatch(/not available in OCPP 1.6/);
    expect(templateStateError({ ...valid, ocppVersion: '1.6' })).toBeNull();
  });

  it('requires startSchedule for Absolute and Recurring profiles (K01.FR.40)', () => {
    expect(templateStateError({ ...valid, startSchedule: null })).toMatch(/startSchedule/);
    expect(
      templateStateError({
        ...valid,
        profileKind: 'Recurring',
        recurrencyKind: 'Daily',
        startSchedule: null,
      }),
    ).toMatch(/startSchedule/);
  });

  it('requires recurrencyKind for a Recurring profile', () => {
    expect(templateStateError({ ...valid, profileKind: 'Recurring' })).toMatch(/recurrencyKind/);
  });

  it('requires the first period at 0 and strictly ascending periods (K01.FR.31)', () => {
    expect(
      templateStateError({ ...valid, schedulePeriods: [{ startPeriod: 60, limit: 1 }] }),
    ).toMatch(/start at 0/);
    expect(
      templateStateError({
        ...valid,
        schedulePeriods: [
          { startPeriod: 0, limit: 1 },
          { startPeriod: 0, limit: 2 },
        ],
      }),
    ).toMatch(/strictly increasing/);
    expect(templateStateError({ ...valid, schedulePeriods: [] })).toMatch(/At least one/);
  });

  it('requires validFrom before validTo', () => {
    expect(
      templateStateError({
        ...valid,
        validFrom: new Date('2026-12-01T00:00:00Z'),
        validTo: '2026-01-01T00:00:00Z',
      }),
    ).toMatch(/validFrom/);
  });
});
