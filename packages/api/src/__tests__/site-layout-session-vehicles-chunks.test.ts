// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

// Each IN list the reads build, and the rows they answer.
const lists: string[][] = [];

vi.mock('drizzle-orm', () => ({
  and: (...parts: unknown[]) => parts[0],
  desc: (c: unknown) => c,
  eq: () => null,
  isNotNull: () => null,
  sql: () => null,
  inArray: (_column: unknown, ids: string[]) => {
    lists.push([...ids]);
    return ids;
  },
}));

vi.mock('@evtivity/database', () => {
  const where = (ids: string[]) => {
    const rows = ids.map((id) => ({
      id: `veh_${id}`,
      driverId: id,
      color: 'red',
      bodyType: 'suv',
    }));
    return Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve([]) });
  };
  const builder = { from: () => ({ where }) };
  return {
    db: { select: () => builder, selectDistinctOn: () => builder },
    chargingSessions: {},
    drivers: {},
    vehicles: {},
  };
});
vi.mock('../services/account-avatar.js', () => ({ withAvatars: vi.fn() }));

import { IN_LIST_CHUNK, inListChunks, readSessionVehicles } from '../lib/site-layout-sessions.js';

describe('readSessionVehicles', () => {
  it('splits its id lists so no query passes the PostgreSQL bind parameter limit', async () => {
    expect(IN_LIST_CHUNK).toBeLessThan(65535);
    expect(inListChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inListChunks([], 2)).toEqual([]);
    const n = 2 * IN_LIST_CHUNK + 7;
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `ses_${String(i)}`,
      vehicleId: null,
      driverId: `drv_${String(i)}`,
    }));
    lists.length = 0;
    const out = await readSessionVehicles(rows);
    expect(lists.length).toBe(3);
    expect(Math.max(...lists.map((l) => l.length))).toBeLessThanOrEqual(IN_LIST_CHUNK);
    expect(lists.flat()).toHaveLength(n);
    // Every session still gets its driver's one vehicle.
    expect(out.size).toBe(n);
    expect(out.get('ses_0')).toEqual({ color: 'red', bodyType: 'suv' });
    expect(out.get(`ses_${String(n - 1)}`)).toEqual({ color: 'red', bodyType: 'suv' });
  });
});
