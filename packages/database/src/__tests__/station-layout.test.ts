// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import type { SiteLayoutSettings } from '@evtivity/lib/site-layout';
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import { chargingStations, sites } from '../schema/assets.js';
import {
  LayoutGridTooSmallError,
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
function fakeTx(
  initial: Row[],
  options: {
    settings?: Record<string, SiteLayoutSettings | null>;
    stations?: Record<string, string[]>;
  } = {},
) {
  const rows = [...initial];
  const settings = new Map<string, SiteLayoutSettings | null>(
    Object.entries(options.settings ?? {}),
  );
  const stationsBySite = new Map(Object.entries(options.stations ?? {}));
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
      from: (table: unknown) => {
        // The site row: its stored layout settings.
        if (table === sites) {
          return {
            where: (cond: unknown) => {
              const siteId = String(params(cond)[0]);
              const stored = settings.get(siteId);
              return Promise.resolve(stored === undefined ? [] : [{ layoutSettings: stored }]);
            },
          };
        }
        // The site's stations with their positions (saveSiteLayout).
        if (table === chargingStations) {
          return {
            leftJoin: () => ({
              where: (cond: unknown) => {
                const siteId = String(params(cond)[0]);
                return Promise.resolve(
                  (stationsBySite.get(siteId) ?? []).map((id) => {
                    const row = rows.find((r) => r.stationId === id && r.siteId === siteId);
                    return {
                      id,
                      stationId: `CS-${id}`,
                      positionX: row?.positionX ?? null,
                      positionY: row?.positionY ?? null,
                    };
                  }),
                );
              },
            }),
          };
        }
        return {
          where: (cond: unknown) => {
            lastSiteFilter = String(params(cond)[0]);
            return Promise.resolve(rows.filter((r) => r.siteId === lastSiteFilter));
          },
        };
      },
    }),
    update: () => ({
      set: (values: { layoutSettings: SiteLayoutSettings | null }) => ({
        where: (cond: unknown) => {
          settings.set(String(params(cond)[0]), values.layoutSettings);
          return Promise.resolve();
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
  return { tx: tx as unknown as StationLayoutDb, rows, locks, settings };
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

  const small = (spotsPerRow: number, rows: number): SiteLayoutSettings => ({
    ...DEFAULT_LAYOUT_GRID,
    spotsPerRow,
    rows,
    transformers: [{ id: 'tx-1', name: 'Main', ratedKva: 1500, x: 3, z: 2 }],
  });

  it('places a new station on the first free spot of a stored lot, below it when the lot is full', async () => {
    const { tx } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '220', positionY: '20' },
      ],
      { settings: { sit_1: small(2, 1) } },
    );
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_c')).toEqual({ x: 20, y: 160 });
  });

  it('stores new settings, moves stations outside the lot inside and the transformers onto the grass', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '820', positionY: '20' },
      ],
      { stations: { sit_1: ['sta_a', 'sta_b'] } },
    );
    const saved = await saveSiteLayout(tx, 'sit_1', [], small(2, 1));
    expect(saved.moved).toEqual([{ stationId: 'sta_b', positionX: 220, positionY: 20 }]);
    expect(rows.find((r) => r.stationId === 'sta_b')).toMatchObject({ positionX: '220' });
    expect(saved.settingsChanged).toBe(true);
    // The transformer stood on the new lot: it moves to the grass beside it.
    const stored = settings.get('sit_1');
    expect(stored?.spotsPerRow).toBe(2);
    expect(stored?.transformers[0]).toMatchObject({ id: 'tx-1', name: 'Main', x: 3, z: -2.5 });
    // Before: the default lot (never saved).
    expect(saved.settingsBefore.spotsPerRow).toBe(10);
  });

  it('refuses a lot without a free spot for every station and writes nothing', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '220', positionY: '20' },
      ],
      { stations: { sit_1: ['sta_a', 'sta_b'] } },
    );
    await expect(saveSiteLayout(tx, 'sit_1', [], small(1, 1))).rejects.toThrow(
      LayoutGridTooSmallError,
    );
    await expect(saveSiteLayout(tx, 'sit_1', [], small(1, 1))).rejects.toMatchObject({
      stations: ['CS-sta_b'],
    });
    expect(rows.find((r) => r.stationId === 'sta_b')).toMatchObject({ positionX: '220' });
    expect(settings.has('sit_1')).toBe(false);
  });

  it('resets the settings to the default with null', async () => {
    const { tx, settings } = fakeTx([], { settings: { sit_1: small(4, 1) } });
    const saved = await saveSiteLayout(tx, 'sit_1', [], null);
    expect(saved.settingsChanged).toBe(true);
    expect(settings.get('sit_1')).toBeNull();
  });
});
