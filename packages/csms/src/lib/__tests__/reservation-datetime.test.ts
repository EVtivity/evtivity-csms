// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getDefaultExpiresAt,
  getDefaultStartsAt,
  nextRepresentableLocal,
  validateReservationDateRange,
} from '../reservation-datetime';

const HOUR_MS = 60 * 60 * 1000;

// US Eastern: DST ends 2026-11-01 at 02:00 EDT (01:00 to 02:00 repeats) and
// starts 2026-03-08 at 02:00 EST (02:00 to 03:00 does not exist).
describe('reservation default times across DST changes (America/New_York)', () => {
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/New_York');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function defaultsAt(nowIso: string): { start: string; end: string } {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nowIso));
    const start = getDefaultStartsAt();
    return { start, end: getDefaultExpiresAt(start) };
  }

  function expectValidWindow({ start, end }: { start: string; end: string }): void {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    expect(startMs).toBeGreaterThanOrEqual(Date.now());
    expect(endMs - startMs).toBeGreaterThanOrEqual(HOUR_MS);
    expect(
      validateReservationDateRange({
        startsAt: start,
        expiresAt: end,
        maxHours: 24,
        startsAtRequired: false,
      }),
    ).toEqual({ startsAtError: null, expiresAtError: null });
  }

  it('checks that the zone is applied', () => {
    expect(new Date('2026-11-01T05:30:00Z').getTimezoneOffset()).toBe(240);
    expect(new Date('2026-11-01T06:30:00Z').getTimezoneOffset()).toBe(300);
  });

  it('keeps one hour after the start on an ordinary day', () => {
    const d = defaultsAt('2026-10-20T14:02:00Z');
    expect(d).toEqual({ start: '2026-10-20T10:10', end: '2026-10-20T11:10' });
    expectValidWindow(d);
  });

  it('never ends at the start in the first occurrence of the repeated hour', () => {
    // 01:08 EDT: start + 1 h is 01:15 EST, which reads back as 01:15 EDT.
    const d = defaultsAt('2026-11-01T05:08:00Z');
    expect(d.start).toBe('2026-11-01T01:15');
    expect(d.end).not.toBe(d.start);
    expect(d.end).toBe('2026-11-01T02:00');
    expectValidWindow(d);
  });

  it('never starts in the past in the second occurrence of the repeated hour', () => {
    // 01:08 EST: "01:15" would read back as 01:15 EDT, an hour ago.
    const d = defaultsAt('2026-11-01T06:08:00Z');
    expect(d).toEqual({ start: '2026-11-01T02:00', end: '2026-11-01T03:00' });
    expectValidWindow(d);
  });

  it('keeps one hour of real time across the spring forward gap', () => {
    // 01:58 EST: now + 5 min is 03:03 EDT.
    const d = defaultsAt('2026-03-08T06:58:00Z');
    expect(d).toEqual({ start: '2026-03-08T03:05', end: '2026-03-08T04:05' });
    expectValidWindow(d);
  });

  it('moves an instant of the second occurrence to the first value that names it', () => {
    const second = new Date('2026-11-01T06:20:00Z');
    expect(nextRepresentableLocal(second).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    const first = new Date('2026-11-01T05:20:00Z');
    expect(nextRepresentableLocal(first).toISOString()).toBe(first.toISOString());
  });
});
