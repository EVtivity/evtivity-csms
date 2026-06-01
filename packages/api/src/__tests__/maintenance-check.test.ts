// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'innerJoin',
    'leftJoin',
    'groupBy',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ): Promise<unknown> => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  return chain;
}

const publishMock = vi.fn(async () => undefined);

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  maintenanceEvents: {
    id: 'id',
    siteId: 'siteId',
    status: 'status',
    plannedStartAt: 'plannedStartAt',
    plannedEndAt: 'plannedEndAt',
    affectedStationIds: 'affectedStationIds',
  },
  chargingStations: {
    id: 'id',
    siteId: 'siteId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: (): { publish: typeof publishMock } => ({ publish: publishMock }),
}));

import {
  findMaintenanceConflicts,
  assertNoMaintenanceConflict,
  invalidateMaintenanceCheckCache,
  clearMaintenanceCheckCacheLocal,
} from '../lib/maintenance-check.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
  clearMaintenanceCheckCacheLocal();
});

describe('findMaintenanceConflicts', () => {
  it('returns [] when station has no site', async () => {
    setupDbResults([]); // station lookup empty
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toEqual([]);
  });

  it('returns [] when no maintenance events on the site', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }], // station -> site
      [], // events
    );
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toEqual([]);
  });

  it('returns event when site-wide maintenance overlaps the window', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_1',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: null,
        },
      ],
    );
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe('mne_1');
  });

  it('filters out events targeting other stations', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_other',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: ['sta_other'],
        },
      ],
    );
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toEqual([]);
  });

  it('includes events that explicitly list the station', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_specific',
          siteId: 'sit_a',
          status: 'active',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: ['sta_x', 'sta_y'],
        },
      ],
    );
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toHaveLength(1);
  });

  it('filters out non-overlapping events', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_past',
          siteId: 'sit_a',
          status: 'completed',
          plannedStartAt: new Date('2026-06-01T01:00:00Z'),
          plannedEndAt: new Date('2026-06-01T05:00:00Z'),
          affectedStationIds: null,
        },
        {
          id: 'mne_future',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T20:00:00Z'),
          plannedEndAt: new Date('2026-06-01T22:00:00Z'),
          affectedStationIds: null,
        },
      ],
    );
    const result = await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result).toEqual([]);
  });

  it('caches station -> events and reuses for subsequent calls in the same window', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_1',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: null,
        },
      ],
    );

    const { db } = await import('@evtivity/database');
    const firstCallCount = vi.mocked(db.select).mock.calls.length;

    await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    const afterFirst = vi.mocked(db.select).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(firstCallCount);

    await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T11:00:00Z'),
      new Date('2026-06-01T11:30:00Z'),
    );
    const afterSecond = vi.mocked(db.select).mock.calls.length;
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('assertNoMaintenanceConflict', () => {
  it('does not throw when there are no conflicts', async () => {
    setupDbResults([{ siteId: 'sit_a' }], []);
    await expect(
      assertNoMaintenanceConflict(
        'sta_x',
        new Date('2026-06-01T10:00:00Z'),
        new Date('2026-06-01T12:00:00Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws AppError with code RESERVATION_DURING_MAINTENANCE on conflict', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_1',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: null,
        },
      ],
    );
    await expect(
      assertNoMaintenanceConflict(
        'sta_x',
        new Date('2026-06-01T10:00:00Z'),
        new Date('2026-06-01T12:00:00Z'),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESERVATION_DURING_MAINTENANCE',
    });
  });

  it('exposes the conflicting event ID and window on the thrown error', async () => {
    setupDbResults(
      [{ siteId: 'sit_a' }],
      [
        {
          id: 'mne_1',
          siteId: 'sit_a',
          status: 'scheduled',
          plannedStartAt: new Date('2026-06-01T09:00:00Z'),
          plannedEndAt: new Date('2026-06-01T13:00:00Z'),
          affectedStationIds: null,
        },
      ],
    );
    let caught: unknown;
    try {
      await assertNoMaintenanceConflict(
        'sta_x',
        new Date('2026-06-01T10:00:00Z'),
        new Date('2026-06-01T12:00:00Z'),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      details: {
        maintenanceEventId: 'mne_1',
        plannedStartAt: new Date('2026-06-01T09:00:00Z').toISOString(),
        plannedEndAt: new Date('2026-06-01T13:00:00Z').toISOString(),
      },
    });
  });
});

describe('invalidateMaintenanceCheckCache', () => {
  it('publishes cache_invalidate with kind=maintenance', () => {
    invalidateMaintenanceCheckCache();
    expect(publishMock).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'maintenance' }),
    );
  });

  it('clears the local cache so the next call hits the DB', async () => {
    setupDbResults([{ siteId: 'sit_a' }], [], [{ siteId: 'sit_a' }], []);

    const { db } = await import('@evtivity/database');

    await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    const afterFirst = vi.mocked(db.select).mock.calls.length;

    invalidateMaintenanceCheckCache();

    await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );
    const afterSecond = vi.mocked(db.select).mock.calls.length;

    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});

describe('clearMaintenanceCheckCacheLocal', () => {
  it('clears cache without publishing', async () => {
    setupDbResults([{ siteId: 'sit_a' }], []);

    await findMaintenanceConflicts(
      'sta_x',
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-01T12:00:00Z'),
    );

    publishMock.mockClear();
    clearMaintenanceCheckCacheLocal();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
