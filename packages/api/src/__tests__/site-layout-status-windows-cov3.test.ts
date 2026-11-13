// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { results } = vi.hoisted(() => ({ results: [] as unknown[][] }));

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/reservations.js')),
  ...(await import('@evtivity/database/src/schema/maintenance.js')),
  db: {
    select: () => {
      const rows = results.shift() ?? [];
      const self: Record<string, unknown> = {};
      self['from'] = () => self;
      self['where'] = () => self;
      self['orderBy'] = () => Promise.resolve(rows);
      return self;
    },
  },
}));

import {
  readLayoutMaintenanceWindows,
  readLayoutReservations,
} from '../lib/site-layout-status-windows.js';

beforeEach(() => {
  results.length = 0;
});

describe('readLayoutReservations', () => {
  it('reads nothing for no stations', async () => {
    results.push([{ stationId: 'sta_1', startsAt: null, expiresAt: new Date() }]);
    expect((await readLayoutReservations([])).size).toBe(0);
    expect(results).toHaveLength(1);
  });

  it('keeps the earliest ending reservation per station', async () => {
    results.push([
      { stationId: 'sta_1', startsAt: null, expiresAt: new Date('2026-11-03T10:00:00Z') },
      { stationId: 'sta_2', startsAt: '2026-11-03T08:00:00Z', expiresAt: '2026-11-03T11:00:00Z' },
      { stationId: 'sta_1', startsAt: null, expiresAt: new Date('2026-11-03T12:00:00Z') },
    ]);
    const out = await readLayoutReservations(['sta_1', 'sta_2']);
    expect(out.get('sta_1')).toEqual({ startsAt: null, endsAt: '2026-11-03T10:00:00.000Z' });
    expect(out.get('sta_2')).toEqual({
      startsAt: '2026-11-03T08:00:00.000Z',
      endsAt: '2026-11-03T11:00:00.000Z',
    });
  });
});

describe('readLayoutMaintenanceWindows', () => {
  it('reads nothing for no stations', async () => {
    expect((await readLayoutMaintenanceWindows('sit_1', [])).size).toBe(0);
  });

  it('covers the whole site without affected stations and only the named ones otherwise', async () => {
    results.push([
      {
        startedAt: null,
        plannedStartAt: new Date('2026-11-03T06:00:00Z'),
        plannedEndAt: new Date('2026-11-03T09:00:00Z'),
        affected: ['sta_2'],
      },
      {
        startedAt: new Date('2026-11-03T07:30:00Z'),
        plannedStartAt: new Date('2026-11-03T07:00:00Z'),
        plannedEndAt: new Date('2026-11-03T10:00:00Z'),
        affected: [],
      },
      {
        startedAt: null,
        plannedStartAt: new Date('2026-11-03T05:00:00Z'),
        plannedEndAt: new Date('2026-11-03T12:00:00Z'),
        affected: null,
      },
    ]);
    const out = await readLayoutMaintenanceWindows('sit_1', ['sta_1', 'sta_2']);
    expect(out.get('sta_2')).toEqual({
      startsAt: '2026-11-03T06:00:00.000Z',
      endsAt: '2026-11-03T09:00:00.000Z',
    });
    expect(out.get('sta_1')).toEqual({
      startsAt: '2026-11-03T07:30:00.000Z',
      endsAt: '2026-11-03T10:00:00.000Z',
    });
  });
});
