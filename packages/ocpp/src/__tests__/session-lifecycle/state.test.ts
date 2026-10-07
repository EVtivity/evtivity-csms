// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { CostUpdatedThrottle } from '../../server/session-lifecycle/state.js';

const INTERVAL_MS = 30_000;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

describe('CostUpdatedThrottle', () => {
  it('is due on the first call for a session', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    expect(throttle.due('session-1', T0)).toBe(true);
  });

  it('is not due within the interval after markSent', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    throttle.markSent('session-1', T0);
    expect(throttle.due('session-1', T0)).toBe(false);
    expect(throttle.due('session-1', T0 + INTERVAL_MS - 1)).toBe(false);
  });

  it('is due again once the full interval has passed (>=)', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    throttle.markSent('session-1', T0);
    expect(throttle.due('session-1', T0 + INTERVAL_MS)).toBe(true);
    expect(throttle.due('session-1', T0 + INTERVAL_MS + 1)).toBe(true);
  });

  it('tracks each session on its own', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    throttle.markSent('session-1', T0);
    expect(throttle.due('session-2', T0)).toBe(true);
  });

  it('forget resets a session', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    throttle.markSent('session-1', T0);
    throttle.forget('session-1');
    expect(throttle.due('session-1', T0)).toBe(true);
  });

  it('counts a session never sent as last sent at epoch 0, as the MeterValues code did', () => {
    const throttle = new CostUpdatedThrottle(INTERVAL_MS);
    expect(throttle.due('session-1', INTERVAL_MS - 1)).toBe(false);
    expect(throttle.due('session-1', INTERVAL_MS)).toBe(true);
  });
});
