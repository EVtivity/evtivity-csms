// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  heartbeatTimeoutFor,
  offlineSweepThresholdMs,
  shouldMarkStationOffline,
} from '../station-liveness.js';

describe('heartbeatTimeoutFor', () => {
  it('is 3 heartbeat intervals and never less than 15 minutes', () => {
    expect(heartbeatTimeoutFor(300)).toBe(900_000);
    expect(heartbeatTimeoutFor(60)).toBe(900_000);
    expect(heartbeatTimeoutFor(900)).toBe(2_700_000);
  });
});

describe('offlineSweepThresholdMs', () => {
  it('is the heartbeat timeout plus one minute of slack', () => {
    expect(offlineSweepThresholdMs(300)).toBe(960_000);
    expect(offlineSweepThresholdMs(900)).toBe(2_760_000);
  });
});

describe('shouldMarkStationOffline', () => {
  const staleBefore = new Date('2026-10-06T12:00:00Z');
  const stale = new Date('2026-10-06T11:59:59Z');
  const fresh = new Date('2026-10-06T12:00:01Z');

  it.each([
    { owner: 'pod-a', activity: stale, expected: false, label: 'key present, stale' },
    { owner: 'pod-a', activity: fresh, expected: false, label: 'key present, fresh' },
    { owner: 'pod-a', activity: null, expected: false, label: 'key present, no activity' },
    { owner: null, activity: fresh, expected: false, label: 'no key, fresh' },
    { owner: null, activity: stale, expected: true, label: 'no key, stale' },
    { owner: null, activity: null, expected: true, label: 'no key, no activity' },
  ])('$label -> $expected', ({ owner, activity, expected }) => {
    expect(
      shouldMarkStationOffline({ registryOwner: owner, lastActivityAt: activity, staleBefore }),
    ).toBe(expected);
  });

  it('treats activity exactly at the cutoff as fresh', () => {
    expect(
      shouldMarkStationOffline({ registryOwner: null, lastActivityAt: staleBefore, staleBefore }),
    ).toBe(false);
  });
});
