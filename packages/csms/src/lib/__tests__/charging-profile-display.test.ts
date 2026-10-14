// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { compositeScheduleAnchor, ocppProfileId } from '../charging-profile-display';

describe('compositeScheduleAnchor', () => {
  it('reads schedule.scheduleStart of a 2.1 composite schedule', () => {
    expect(
      compositeScheduleAnchor({ schedule: { scheduleStart: '2026-10-13T08:00:00.000Z' } }),
    ).toBe('2026-10-13T08:00:00.000Z');
  });

  it('returns null when the station sent no start', () => {
    expect(compositeScheduleAnchor({ schedule: {} })).toBeNull();
    expect(compositeScheduleAnchor({})).toBeNull();
  });
});

describe('ocppProfileId', () => {
  it('reads the 2.1 id of a CSMS-set profile', () => {
    expect(ocppProfileId({ profileData: { id: 12 } })).toBe(12);
    expect(ocppProfileId({ profileData: { id: '13' } })).toBe(13);
  });

  it('reads the id of a profile set in 1.6 form', () => {
    expect(ocppProfileId({ profileData: { chargingProfileId: 4 } })).toBe(4);
  });

  it('reads the id of a station report holding one profile', () => {
    expect(ocppProfileId({ profileData: [{ id: 7 }] })).toBe(7);
  });

  it('names no single id for a report with several profiles or none', () => {
    expect(ocppProfileId({ profileData: [{ id: 7 }, { id: 8 }] })).toBeNull();
    expect(ocppProfileId({ profileData: [] })).toBeNull();
    expect(ocppProfileId({ profileData: { id: 'abc' } })).toBeNull();
  });
});
