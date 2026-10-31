// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, operatorStationSql: () => 'true' }));

import {
  REPLAY_MAX_CHANGES,
  onlineTimeline,
  powerToKw,
  replayDayBounds,
  stationPowerSeries,
  stationReplaySince,
  zonedDate,
} from '../lib/site-layout-replay.js';

const now = new Date('2026-10-31T12:00:00Z');

describe('site layout replay day bounds', () => {
  it('reads the day in the site timezone, DST change included', () => {
    expect(replayDayBounds('2026-10-30', 'UTC', now)).toEqual({
      from: new Date('2026-10-30T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
    });
    expect(replayDayBounds('2026-10-30', 'America/Los_Angeles', now)).toEqual({
      from: new Date('2026-10-30T07:00:00Z'),
      to: new Date('2026-10-31T07:00:00Z'),
    });
    // Europe/Berlin leaves summer time on 2026-10-25: a 25-hour day.
    const dst = replayDayBounds('2026-10-25', 'Europe/Berlin', now);
    expect(dst).toEqual({
      from: new Date('2026-10-24T22:00:00Z'),
      to: new Date('2026-10-25T23:00:00Z'),
    });
  });

  it('refuses a future day, one more than 90 days back and an impossible date', () => {
    expect(replayDayBounds('2026-11-01', 'UTC', now)).toBe('future');
    // Already 1 November at Kiritimati (UTC+14, 02:00 there): not future.
    expect(typeof replayDayBounds('2026-11-01', 'Pacific/Kiritimati', now)).toBe('object');
    expect(typeof replayDayBounds('2026-08-02', 'UTC', now)).toBe('object');
    expect(replayDayBounds('2026-08-01', 'UTC', now)).toBe('too_old');
    expect(replayDayBounds('2026-02-30', 'UTC', now)).toBe('invalid');
    expect(replayDayBounds('20261030', 'UTC', now)).toBe('invalid');
    expect(zonedDate(now, 'Asia/Tokyo')).toBe('2026-10-31');
  });
});

describe('site layout replay power', () => {
  it('converts W and kW like the live draw', () => {
    expect(powerToKw(7400, 'W')).toBe(7.4);
    expect(powerToKw(7400, null)).toBe(7.4);
    expect(powerToKw(50, 'kW')).toBe(50);
  });

  it('sums EVSEs per bucket and uses a station reading only without one', () => {
    const t1 = new Date('2026-10-30T10:00:00Z');
    const t2 = new Date('2026-10-30T10:05:00Z');
    expect(
      stationPowerSeries([
        { bucket: t2, evseId: null, kw: 11 },
        { bucket: t1, evseId: 'e1', kw: 7.4 },
        { bucket: t1, evseId: 'e2', kw: 3.6 },
        { bucket: t1, evseId: null, kw: 99 },
      ]),
    ).toEqual([
      { at: t1.toISOString(), kw: 11 },
      { at: t2.toISOString(), kw: 11 },
    ]);
  });
});

describe('site layout replay online timeline', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 30, h));

  it('starts from the last event before the day and drops repeats', () => {
    expect(
      onlineTimeline(
        { at: at(0), online: true },
        [
          { at: at(3), online: true },
          { at: at(2), online: false },
          { at: at(4), online: true },
        ],
        false,
      ),
    ).toEqual({
      initialOnline: true,
      onlineChanges: [
        { at: at(2).toISOString(), online: false },
        { at: at(3).toISOString(), online: true },
      ],
    });
  });

  it('without an earlier event takes the opposite of the first change, else the current state', () => {
    expect(onlineTimeline(null, [{ at: at(5), online: true }], false).initialOnline).toBe(false);
    expect(onlineTimeline(null, [], true)).toEqual({ initialOnline: true, onlineChanges: [] });
  });

  it('cuts the changes off at the limit', () => {
    const events = Array.from({ length: REPLAY_MAX_CHANGES + 10 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 30) + i * 1000),
      online: i % 2 === 0,
    }));
    expect(onlineTimeline(null, events, false).onlineChanges).toHaveLength(REPLAY_MAX_CHANGES);
  });
});

describe('site layout replay site window', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 30, h));
  const none = { placedAt: null, lastMove: null, foreignSessionUntil: null };

  it('has no bound for a station nothing shows elsewhere', () => {
    expect(stationReplaySince(none, 'site_b')).toBeNull();
  });

  it('starts at the latest of the placement, the audited move here and a session elsewhere', () => {
    expect(
      stationReplaySince(
        {
          placedAt: t(10),
          lastMove: { at: t(9), siteId: 'site_b' },
          foreignSessionUntil: t(11),
        },
        'site_b',
      ),
    ).toEqual(t(11));
    expect(stationReplaySince({ ...none, placedAt: t(12) }, 'site_b')).toEqual(t(12));
  });

  it('fails closed when the newest audited move went to another site', () => {
    expect(
      stationReplaySince(
        { ...none, placedAt: t(1), lastMove: { at: t(5), siteId: 'site_a' } },
        'site_b',
      ),
    ).toBe('closed');
    expect(stationReplaySince({ ...none, lastMove: { at: t(5), siteId: null } }, 'site_b')).toBe(
      'closed',
    );
  });
});
