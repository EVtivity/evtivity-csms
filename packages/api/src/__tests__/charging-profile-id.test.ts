// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {},
  chargingStations: {},
  stationConfigurations: {},
}));

import { assertProfileIdAllowed, isReservedProfileId } from '../lib/charging-profile-id.js';

describe('charging profile id against MaxExternalConstraintsId (K01.FR.81)', () => {
  it('reserves ids at or below the station value', () => {
    expect(isReservedProfileId(5000, 5000)).toBe(true);
    expect(isReservedProfileId(4999, 5000)).toBe(true);
    expect(isReservedProfileId(5001, 5000)).toBe(false);
  });

  it('checks nothing for a station without a recorded value', () => {
    expect(isReservedProfileId(1, null)).toBe(false);
    expect(() => {
      assertProfileIdAllowed(1, undefined);
    }).not.toThrow();
  });

  it('refuses a reserved id with 400 CHARGING_PROFILE_ID_RESERVED', () => {
    expect(() => {
      assertProfileIdAllowed(10, 5000);
    }).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'CHARGING_PROFILE_ID_RESERVED',
      }) as Error,
    );
  });
});
