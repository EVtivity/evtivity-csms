// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  isStationStuck,
  STUCK_GRACE_MS,
  MAX_HEAL_ATTEMPTS,
  type StuckCheckState,
} from '../simulator-heal.js';

// A station that booted Accepted but has been not-ready well past the grace
// period -- the cold-start-storm jam the watchdog exists to clear.
const stuck: StuckCheckState = {
  ready: false,
  notReadyMs: STUCK_GRACE_MS + 60_000,
  bootStatus: 'Accepted',
  healAttempts: 0,
  offline: false,
};

describe('isStationStuck', () => {
  it('heals a station stuck past the grace period after an Accepted boot', () => {
    expect(isStationStuck(stuck)).toBe(true);
  });

  it('heals a station that never got a boot response (null) once past grace', () => {
    expect(isStationStuck({ ...stuck, bootStatus: null })).toBe(true);
  });

  it('never heals a ready station', () => {
    expect(isStationStuck({ ...stuck, ready: true })).toBe(false);
  });

  it('never heals within the grace period', () => {
    expect(isStationStuck({ ...stuck, notReadyMs: STUCK_GRACE_MS - 1 })).toBe(false);
  });

  it('treats exactly the grace boundary as not-yet-stuck', () => {
    expect(isStationStuck({ ...stuck, notReadyMs: STUCK_GRACE_MS })).toBe(false);
  });

  it('never heals a station awaiting onboarding approval (Pending)', () => {
    expect(isStationStuck({ ...stuck, bootStatus: 'Pending' })).toBe(false);
  });

  it('never heals a Rejected station', () => {
    expect(isStationStuck({ ...stuck, bootStatus: 'Rejected' })).toBe(false);
  });

  it('never heals a station chaos deliberately parked offline (goOffline)', () => {
    expect(isStationStuck({ ...stuck, offline: true })).toBe(false);
  });

  it('gives up once the restart budget is exhausted', () => {
    expect(isStationStuck({ ...stuck, healAttempts: MAX_HEAL_ATTEMPTS })).toBe(false);
  });

  it('still heals on the final allowed attempt', () => {
    expect(isStationStuck({ ...stuck, healAttempts: MAX_HEAL_ATTEMPTS - 1 })).toBe(true);
  });
});
