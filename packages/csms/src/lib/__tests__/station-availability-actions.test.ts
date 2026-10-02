// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { stationAvailabilityActions } from '../station-availability-actions';

const base = { disabledReason: null, firmwareState: null, reportedStatus: null };

describe('stationAvailabilityActions', () => {
  it('offers only Disable for a station with no station-level state', () => {
    expect(stationAvailabilityActions(base)).toEqual({ enable: false, disable: true });
    expect(stationAvailabilityActions({ ...base, reportedStatus: 'available' })).toEqual({
      enable: false,
      disable: true,
    });
  });

  it.each(['operator', 'security'])('offers only Enable for a %s disable', (disabledReason) => {
    expect(
      stationAvailabilityActions({ ...base, disabledReason, firmwareState: 'installing' }),
    ).toEqual({ enable: true, disable: false });
  });

  it.each(['installing', 'failed'])(
    'offers Enable and Disable while firmware is %s',
    (firmwareState) => {
      expect(stationAvailabilityActions({ ...base, firmwareState })).toEqual({
        enable: true,
        disable: true,
      });
    },
  );

  it('offers Enable and Disable when the station reports itself unavailable', () => {
    expect(stationAvailabilityActions({ ...base, reportedStatus: 'unavailable' })).toEqual({
      enable: true,
      disable: true,
    });
  });
});
