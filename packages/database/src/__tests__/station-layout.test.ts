// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import {
  moveStationLayout,
  placeStationOnLayout,
  saveSiteLayout,
  type StationLayoutDb,
} from '../lib/station-layout.js';

interface Row {
  siteId: string;
  stationId: string;
  positionX: string;
  positionY: string;
}

/** A fake transaction over an in-memory station_layout_positions table. */
function fakeTx(initial: Row[]) {
  const rows = [...initial];
  const locks: string[] = [];
  let lastSiteFilter: string | null = null;
  // The module filters reads by site and deletes by station; the fake reads the
  // bound parameter values out of the drizzle condition.
  const params = (cond: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') out.push(node);
      if (node == null || typeof node !== 'object') return;
      const n = node as { value?: unknown; queryChunks?: unknown[]; encoder?: unknown };
      if ('encoder' in n && 'value' in n) out.push(n.value);
      if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
    };
    walk(cond);
    return out;
  };
  const tx = {
    execute: (q: unknown) => {
      locks.push(String(params(q)[0]));
      return Promise.resolve([]);
    },
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          lastSiteFilter = String(params(cond)[0]);
          return Promise.resolve(rows.filter((r) => r.siteId === lastSiteFilter));
        },
      }),
    }),
    delete: () => ({
      where: (cond: unknown) => {
        const stationId = String(params(cond)[0]);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.stationId === stationId) rows.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (v: Row) => {
        const push = (): void => {
          const i = rows.findIndex((r) => r.stationId === v.stationId);
          if (i >= 0) rows.splice(i, 1);
          rows.push({ ...v });
        };
        return {
          onConflictDoUpdate: () => {
            push();
            return Promise.resolve();
          },
          then: (resolve: (v: unknown) => void) => {
            push();
            resolve(undefined);
          },
        };
      },
    }),
  };
  return { tx: tx as unknown as StationLayoutDb, rows, locks };
}

describe('station layout placement', () => {
  it('places the first station of a site on the first slot', async () => {
    const { tx, rows, locks } = fakeTx([]);
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_1')).toEqual({ x: 20, y: 20 });
    expect(rows).toEqual([
      { siteId: 'sit_1', stationId: 'sta_1', positionX: '20', positionY: '20' },
    ]);
    expect(locks).toEqual(['station_layout:sit_1']);
  });

  it('places a new station on the first slot no placed station overlaps', async () => {
    const { tx } = fakeTx([
      { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
      { siteId: 'sit_1', stationId: 'sta_b', positionX: '300', positionY: '30' },
      { siteId: 'sit_2', stationId: 'sta_c', positionX: '220', positionY: '20' },
    ]);
    // Slot 220 overlaps sta_b at 300; 420 overlaps it too; 620 is free. sta_c is another site.
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_new')).toEqual({ x: 620, y: 20 });
  });

  it('keeps an existing position at the same site', async () => {
    const { tx, rows } = fakeTx([
      { siteId: 'sit_1', stationId: 'sta_a', positionX: '440', positionY: '300' },
    ]);
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_a')).toEqual({ x: 440, y: 300 });
    expect(rows).toHaveLength(1);
  });

  it('moves a station: drops the old site position and places it at the new site', async () => {
    const { tx, rows } = fakeTx([
      { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
      { siteId: 'sit_2', stationId: 'sta_b', positionX: '20', positionY: '20' },
    ]);
    await moveStationLayout(tx, 'sta_a', 'sit_2');
    expect(rows.find((r) => r.stationId === 'sta_a')).toEqual({
      siteId: 'sit_2',
      stationId: 'sta_a',
      positionX: '220',
      positionY: '20',
    });
    expect(rows.filter((r) => r.siteId === 'sit_1')).toEqual([]);
  });

  it('drops the position of a station that leaves every site', async () => {
    const { tx, rows } = fakeTx([
      { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
    ]);
    await moveStationLayout(tx, 'sta_a', null);
    expect(rows).toEqual([]);
  });

  it('saves a whole layout under the site lock', async () => {
    const { tx, rows, locks } = fakeTx([]);
    await saveSiteLayout(tx, 'sit_1', [
      { stationId: 'sta_a', positionX: 20, positionY: 20 },
      { stationId: 'sta_b', positionX: 220, positionY: 20 },
    ]);
    expect(rows.map((r) => r.stationId)).toEqual(['sta_a', 'sta_b']);
    expect(locks).toEqual(['station_layout:sit_1']);
  });
});
