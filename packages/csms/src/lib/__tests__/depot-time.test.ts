// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { depotLocalToIso, isoToDepotLocal } from '../depot-time';

describe('depot time', () => {
  it('reads a local date and time at the depot as an instant', () => {
    expect(depotLocalToIso('2026-11-03', '05:30', 'America/Los_Angeles')).toBe(
      '2026-11-03T13:30:00.000Z',
    );
    expect(depotLocalToIso('2026-07-03', '05:30', 'America/Los_Angeles')).toBe(
      '2026-07-03T12:30:00.000Z',
    );
    expect(depotLocalToIso('2026-07-03', '05:30', 'Europe/Berlin')).toBe(
      '2026-07-03T03:30:00.000Z',
    );
  });

  it('falls back to UTC for an unknown time zone and refuses a bad date', () => {
    expect(depotLocalToIso('2026-07-03', '05:30', null)).toBe('2026-07-03T05:30:00.000Z');
    expect(depotLocalToIso('2026-02-30', '05:30', 'UTC')).toBeNull();
    expect(depotLocalToIso('2026-07-03', '25:00', 'UTC')).toBeNull();
  });

  it('shows an instant as the depot date and time, across midnight', () => {
    expect(isoToDepotLocal('2026-11-03T13:30:00.000Z', 'America/Los_Angeles')).toEqual({
      date: '2026-11-03',
      time: '05:30',
    });
    expect(isoToDepotLocal('2026-11-03T02:15:00.000Z', 'America/Los_Angeles')).toEqual({
      date: '2026-11-02',
      time: '18:15',
    });
  });
});
