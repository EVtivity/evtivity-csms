// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB mock helpers
let dbSelectResult: unknown[] = [];

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      return Promise.resolve(result).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

const mockGetReservationSettings = vi.fn();
const mockDbSelect = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  reservations: {
    id: 'id',
    stationId: 'stationId',
    evseId: 'evseId',
    status: 'status',
    expiresAt: 'expiresAt',
    startsAt: 'startsAt',
    createdAt: 'createdAt',
  },
  getReservationSettings: (...args: unknown[]) => mockGetReservationSettings(...args),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, _val) => ({ type: 'eq' })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  or: vi.fn((...conditions) => ({ type: 'or', conditions })),
  inArray: vi.fn((_col, _vals) => ({ type: 'inArray' })),
  gte: vi.fn((_col, _val) => ({ type: 'gte' })),
  lte: vi.fn((_col, _val) => ({ type: 'lte' })),
  isNull: vi.fn((_col) => ({ type: 'isNull' })),
  sql: vi.fn((_strings, ..._values) => ({ type: 'sql' })),
}));

import { isEvseInReservationBuffer } from '../lib/reservation-buffer.js';

describe('isEvseInReservationBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect.mockImplementation(() => makeChain(dbSelectResult));
  });

  it('returns false immediately when bufferMinutes is 0 without making a DB call', async () => {
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 0 });

    const result = await isEvseInReservationBuffer('station-1', 'evse-1');

    expect(result).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns true when a station-wide reservation (evseId=null) is within buffer window', async () => {
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 15 });
    dbSelectResult = [{ id: 'rsv_001' }];

    const result = await isEvseInReservationBuffer('station-1', 'evse-1');

    expect(result).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('returns true when an EVSE-level reservation is within buffer window', async () => {
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 10 });
    dbSelectResult = [{ id: 'rsv_002' }];

    const result = await isEvseInReservationBuffer('station-1', 'evse-1');

    expect(result).toBe(true);
  });

  it('returns false when no reservations are found within buffer window', async () => {
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 10 });
    dbSelectResult = [];

    const result = await isEvseInReservationBuffer('station-1', 'evse-1');

    expect(result).toBe(false);
  });

  it('returns true when reservation has startsAt=null but createdAt is within buffer window', async () => {
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 30 });
    // The COALESCE fallback to createdAt is handled in the SQL expression.
    // The DB returns a match indicating createdAt falls within the buffer.
    dbSelectResult = [{ id: 'rsv_003' }];

    const result = await isEvseInReservationBuffer('station-2', null);

    expect(result).toBe(true);
  });

  it('passes an or() condition for evseId when evseDbId is not null', async () => {
    const { or, isNull, eq } = await import('drizzle-orm');
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 15 });
    dbSelectResult = [];

    await isEvseInReservationBuffer('station-1', 'evse-1');

    expect(or).toHaveBeenCalled();
    expect(isNull).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(expect.anything(), 'evse-1');
  });

  it('does not add an evse condition when evseDbId is null', async () => {
    const { or, isNull } = await import('drizzle-orm');
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 15 });
    dbSelectResult = [];

    await isEvseInReservationBuffer('station-1', null);

    expect(or).not.toHaveBeenCalled();
    expect(isNull).not.toHaveBeenCalled();
  });

  it('uses sql COALESCE expressions for the timestamp conditions', async () => {
    const { sql } = await import('drizzle-orm');
    mockGetReservationSettings.mockResolvedValue({ bufferMinutes: 15 });
    dbSelectResult = [];

    await isEvseInReservationBuffer('station-1', 'evse-1');

    // sql tagged template is called twice: once for <= bufferCutoff, once for >= now
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
