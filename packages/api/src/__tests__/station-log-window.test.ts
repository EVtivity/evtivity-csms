// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  siteIds: null as string[] | null,
  stationRows: [] as Array<{ site_id: string | null }>,
  windows: new Map<string, Date | null | 'closed'>(),
}));

vi.mock('@evtivity/database', () => ({
  db: { execute: vi.fn(() => Promise.resolve(mocks.stationRows)) },
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(mocks.siteIds)),
}));
vi.mock('../lib/site-layout-replay.js', () => ({
  readStationSiteWindows: vi.fn(() => Promise.resolve(mocks.windows)),
}));

import { db } from '@evtivity/database';
import { readStationSiteWindows } from '../lib/site-layout-replay.js';
import { stationLogSince } from '../lib/station-log-window.js';

const STATION = 'sta_aaaaaaaaaaaa';

describe('stationLogSince', () => {
  beforeEach(() => {
    mocks.siteIds = ['sit_bbbbbbbbbbbb'];
    mocks.stationRows = [{ site_id: 'sit_bbbbbbbbbbbb' }];
    mocks.windows = new Map();
  });

  it('puts no bound on an all-site user and reads nothing', async () => {
    mocks.siteIds = null;
    expect(await stationLogSince(STATION, 'usr_1')).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("starts a site user's window at the station's time at its current site", async () => {
    const movedAt = new Date('2026-11-03T12:00:00Z');
    mocks.windows = new Map([[STATION, movedAt]]);
    expect(await stationLogSince(STATION, 'usr_2')).toEqual(movedAt);
    expect(readStationSiteWindows).toHaveBeenCalledWith('sit_bbbbbbbbbbbb', [STATION]);
  });

  it('keeps a never-moved station unbounded for a site user', async () => {
    mocks.windows = new Map([[STATION, null]]);
    expect(await stationLogSince(STATION, 'usr_2')).toBeNull();
  });

  it('fails closed for a closed window, a missing window and a station without a site', async () => {
    mocks.windows = new Map([[STATION, 'closed']]);
    expect(await stationLogSince(STATION, 'usr_2')).toBe('closed');
    mocks.windows = new Map();
    expect(await stationLogSince(STATION, 'usr_2')).toBe('closed');
    mocks.stationRows = [{ site_id: null }];
    expect(await stationLogSince(STATION, 'usr_2')).toBe('closed');
  });
});
