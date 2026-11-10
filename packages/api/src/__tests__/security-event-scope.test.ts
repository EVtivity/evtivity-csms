// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stationRows: [] as Array<{ id: string; site_id: string }>,
  windows: new Map<string, Date | null | 'closed'>(),
}));

vi.mock('@evtivity/database', () => ({
  db: { execute: vi.fn(() => Promise.resolve(mocks.stationRows)) },
  operatorStationSql: (alias: string) => `${alias}.is_conformance = false`,
}));
vi.mock('../lib/site-layout-replay.js', () => ({
  readStationSiteWindows: vi.fn((_site: string, ids: string[]) =>
    Promise.resolve(
      new Map(
        ids.filter((id) => mocks.windows.has(id)).map((id) => [id, mocks.windows.get(id) ?? null]),
      ),
    ),
  ),
}));

import { db } from '@evtivity/database';
import { readStationSiteWindows } from '../lib/site-layout-replay.js';
import { SECURITY_EVENT_WINDOW_CHUNK, securityEventWindows } from '../lib/security-event-scope.js';

const SINCE = new Date('2026-11-03T00:00:00Z');

describe('securityEventWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stationRows = [];
    mocks.windows = new Map();
  });

  it('reads nothing for an empty scope', async () => {
    expect(await securityEventWindows([], SINCE)).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('drops closed and missing windows (fail closed)', async () => {
    mocks.stationRows = [
      { id: 'sta_open', site_id: 'sit_a' },
      { id: 'sta_closed', site_id: 'sit_a' },
      { id: 'sta_missing', site_id: 'sit_a' },
    ];
    mocks.windows = new Map<string, Date | null | 'closed'>([
      ['sta_open', null],
      ['sta_closed', 'closed'],
    ]);
    expect(await securityEventWindows(['sit_a'], SINCE)).toEqual([
      { id: 'sta_open', since: SINCE },
    ]);
  });

  it('starts at the later of the range and the station window', async () => {
    const movedAt = new Date('2026-11-05T12:00:00Z');
    const earlier = new Date('2026-10-01T00:00:00Z');
    mocks.stationRows = [
      { id: 'sta_moved', site_id: 'sit_a' },
      { id: 'sta_old', site_id: 'sit_b' },
    ];
    mocks.windows = new Map([
      ['sta_moved', movedAt],
      ['sta_old', earlier],
    ]);
    const windows = await securityEventWindows(['sit_a', 'sit_b'], SINCE);
    expect(windows).toEqual([
      { id: 'sta_moved', since: movedAt },
      { id: 'sta_old', since: SINCE },
    ]);
    expect(readStationSiteWindows).toHaveBeenCalledWith('sit_a', ['sta_moved']);
    expect(readStationSiteWindows).toHaveBeenCalledWith('sit_b', ['sta_old']);
  });

  it('reads the windows in chunks', async () => {
    const count = SECURITY_EVENT_WINDOW_CHUNK + 3;
    mocks.stationRows = Array.from({ length: count }, (_, i) => ({
      id: `sta_${String(i)}`,
      site_id: 'sit_a',
    }));
    mocks.windows = new Map(mocks.stationRows.map((r) => [r.id, null]));
    const windows = await securityEventWindows(['sit_a'], SINCE);
    expect(windows).toHaveLength(count);
    expect(readStationSiteWindows).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readStationSiteWindows).mock.calls[0]?.[1]).toHaveLength(
      SECURITY_EVENT_WINDOW_CHUNK,
    );
    expect(vi.mocked(readStationSiteWindows).mock.calls[1]?.[1]).toHaveLength(3);
  });
});
