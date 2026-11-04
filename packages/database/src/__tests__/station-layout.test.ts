// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import type { SiteLayoutSettings } from '@evtivity/lib/site-layout';
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import { chargingStations, connectors, sites } from '../schema/assets.js';
import { circuits, panels, siteEnergyAssets, transformers } from '../schema/load-management.js';
import { LoadTreeValidationError } from '../lib/load-management-tree.js';
import {
  boardOf,
  ChargerPlacementSiteTypeError,
  LayoutGridTooSmallError,
  readLayoutPowerEquipment,
  moveStationLayout,
  placeStationOnLayout,
  saveSiteLayout,
  setSiteLayoutType,
  type StationLayoutDb,
} from '../lib/station-layout.js';

interface Row {
  siteId: string;
  stationId: string;
  positionX: string;
  positionY: string;
  freeXM?: string | null;
  freeZM?: string | null;
  freeRotationDeg?: string | null;
}

/** A fake transaction over an in-memory station_layout_positions table. */
function fakeTx(
  initial: Row[],
  options: {
    settings?: Record<string, SiteLayoutSettings | null>;
    stations?: Record<string, string[]>;
    /** EVSEs per station (1 when not given). */
    evses?: Record<string, number>;
    /** Stations with an MCS connector (truck stations on a depot). */
    mcs?: string[];
    /** Stations with a DC (CCS2, 150 kW) or AC (Type2, 22 kW) connector. */
    kinds?: Record<string, 'ac' | 'dc'>;
    /**
     * The power equipment rows of each site: transformer ids (service, 1500
     * kVA) and energy assets. Absent: site sit_1 has transformer tx-1.
     */
    equipment?: Record<
      string,
      { transformers?: string[]; energyAssets?: Array<{ id: string; type: 'battery' | 'solar' }> }
    >;
  } = {},
) {
  const equipment = options.equipment ?? { sit_1: { transformers: ['tx-1'] } };
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
      if ('encoder' in n && 'value' in n) {
        if (Array.isArray(n.value)) out.push(...(n.value as unknown[]));
        else out.push(n.value);
      }
      if (Array.isArray(node)) node.forEach(walk);
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
        // The connectors of in-service EVSEs (the station kinds).
        if (table === connectors) {
          return {
            innerJoin: () => ({
              where: (cond: unknown) => {
                const ids = params(cond).map(String);
                return Promise.resolve(
                  ids.flatMap((id) => {
                    if (options.mcs?.includes(id)) {
                      return [{ stationId: id, connectorType: 'cMCS', maxPowerKw: '1000' }];
                    }
                    const kind = options.kinds?.[id];
                    if (kind == null) return [];
                    return [
                      kind === 'dc'
                        ? { stationId: id, connectorType: 'CCS2', maxPowerKw: '150' }
                        : { stationId: id, connectorType: 'Type2', maxPowerKw: '22' },
                    ];
                  }),
                );
              },
            }),
          };
        }
        // The load management tree (readLayoutPowerEquipment): none here.
        if (table === panels) return { where: () => Promise.resolve([]) };
        if (table === circuits) {
          return { innerJoin: () => ({ where: () => Promise.resolve([]) }) };
        }
        // The site's power equipment rows (readLayoutPowerEquipment).
        if (table === transformers || table === siteEnergyAssets) {
          return {
            where: (cond: unknown) => ({
              orderBy: () => {
                const site = equipment[String(params(cond)[0])];
                return Promise.resolve(
                  table === transformers
                    ? (site?.transformers ?? []).map((id) => ({
                        id,
                        kind: 'service',
                        name: `Transformer ${id}`,
                        ratedKva: '1500',
                        maxContinuousKw: '1425',
                      }))
                    : (site?.energyAssets ?? []).map((a) => ({
                        ...a,
                        name: `Asset ${a.id}`,
                        capacityKwh: a.type === 'battery' ? 500 : null,
                        peakKwp: a.type === 'solar' ? 100 : null,
                      })),
                );
              },
            }),
          };
        }
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
          const mcs = (id: string): boolean => options.mcs?.includes(id) ?? false;
          return {
            // One station's MCS connector (placeStationOnLayout).
            where: (cond: unknown) => {
              const id = String(params(cond)[0]);
              return Promise.resolve([{ mcs: mcs(id) }]);
            },
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
                      freeXM: row?.freeXM ?? null,
                      freeZM: row?.freeZM ?? null,
                      freeRotationDeg: row?.freeRotationDeg ?? null,
                      evseCount: options.evses?.[id] ?? 1,
                      mcs: mcs(id),
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
            return Promise.resolve(
              rows
                .filter((r) => r.siteId === lastSiteFilter)
                .map((r) => ({
                  ...r,
                  evseCount: options.evses?.[r.stationId] ?? 1,
                  mcs: options.mcs?.includes(r.stationId) ?? false,
                })),
            );
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
          // An upsert without the free columns keeps the stored ones.
          const kept = i >= 0 ? rows[i] : undefined;
          if (i >= 0) rows.splice(i, 1);
          rows.push({
            ...(kept?.freeXM !== undefined
              ? {
                  freeXM: kept.freeXM,
                  freeZM: kept.freeZM,
                  freeRotationDeg: kept.freeRotationDeg,
                }
              : {}),
            ...v,
          });
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
    transformers: [{ id: 'tx-1', x: 3, z: 2 }],
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
    expect(stored?.transformers[0]).toEqual({ id: 'tx-1', x: 3, z: -2.5 });
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

  it('stores equipment positions by id: a battery moves to the grass, a canopy keeps its row', async () => {
    const { tx, settings } = fakeTx([], {
      equipment: {
        sit_1: {
          transformers: ['tx-1'],
          energyAssets: [
            { id: 'ena_bat', type: 'battery' },
            { id: 'ena_pv', type: 'solar' },
          ],
        },
      },
    });
    await saveSiteLayout(tx, 'sit_1', [], {
      ...small(4, 2),
      energyAssets: [
        { id: 'ena_bat', x: 2, z: 2 },
        { id: 'ena_pv', row: 1 },
      ],
    });
    const stored = settings.get('sit_1');
    expect(stored?.transformers).toEqual([{ id: 'tx-1', x: 3, z: -2.5 }]);
    expect(stored?.energyAssets).toEqual([
      { id: 'ena_bat', x: -2.5, z: 2 },
      { id: 'ena_pv', row: 1 },
    ]);
  });

  it('refuses a position naming equipment the site does not have and writes nothing', async () => {
    const { tx, settings } = fakeTx([], {
      equipment: { sit_1: { transformers: ['tx-1'] }, sit_2: { transformers: ['tx-other'] } },
    });
    const foreign = { ...small(4, 1), transformers: [{ id: 'tx-other', x: 3, z: 2 }] };
    await expect(saveSiteLayout(tx, 'sit_1', [], foreign)).rejects.toThrow(LoadTreeValidationError);
    await expect(saveSiteLayout(tx, 'sit_1', [], foreign)).rejects.toMatchObject({
      field: 'settings.transformers',
    });
    await expect(
      saveSiteLayout(tx, 'sit_1', [], {
        ...small(4, 1),
        energyAssets: [{ id: 'ena_x', x: 1, z: 1 }],
      }),
    ).rejects.toMatchObject({ field: 'settings.energyAssets' });
    expect(settings.has('sit_1')).toBe(false);
  });

  it('drops the stored positions of deleted equipment on the next Save', async () => {
    const stored: SiteLayoutSettings = {
      ...small(4, 1),
      transformers: [
        { id: 'tx-1', x: 3, z: -2.5 },
        { id: 'tx-gone', x: 20, z: -2.5 },
      ],
      energyAssets: [{ id: 'ena_gone', x: 1, z: -2.5 }],
    };
    const { tx, settings } = fakeTx([], { settings: { sit_1: stored } });
    const saved = await saveSiteLayout(tx, 'sit_1', []);
    expect(saved.settingsChanged).toBe(true);
    expect(settings.get('sit_1')?.transformers).toEqual([{ id: 'tx-1', x: 3, z: -2.5 }]);
    expect(settings.get('sit_1')?.energyAssets).toEqual([]);
    // A second Save finds nothing to drop.
    expect((await saveSiteLayout(tx, 'sit_1', [])).settingsChanged).toBe(false);
  });

  it('reads the power equipment rows the layout labels', async () => {
    const { tx } = fakeTx([], {
      equipment: {
        sit_1: { transformers: ['tx-1'], energyAssets: [{ id: 'b', type: 'battery' }] },
      },
    });
    expect(await readLayoutPowerEquipment('sit_1', tx)).toEqual({
      transformers: [
        {
          id: 'tx-1',
          kind: 'service',
          name: 'Transformer tx-1',
          ratedKva: 1500,
          maxContinuousKw: 1425,
        },
      ],
      energyAssets: [
        { id: 'b', type: 'battery', name: 'Asset b', capacityKwh: 500, peakKwp: null },
      ],
    });
  });

  it('sets the site type, moves stations onto the new spots and keeps every other field', async () => {
    const { tx, rows, settings, locks } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '20', positionY: '160' },
      ],
      {
        settings: { sit_1: { ...small(4, 2), chargersLeft: 1, chargersRight: 2 } },
        stations: { sit_1: ['sta_a', 'sta_b'] },
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', 'office_retail');
    expect(locks).toEqual(['station_layout:sit_1']);
    expect(change.changed).toBe(true);
    expect(change.settingsBefore.siteType).toBe('parking_lot');
    // One charger position per station until a layout Save stores a count.
    expect(change.settingsAfter).toMatchObject({
      siteType: 'office_retail',
      chargers: 2,
      mounting: 'wall',
    });
    expect(change.moved).toEqual([{ stationId: 'sta_b', positionX: 220, positionY: 20 }]);
    expect(rows.find((r) => r.stationId === 'sta_b')).toMatchObject({
      positionX: '220',
      positionY: '20',
    });
    const stored = settings.get('sit_1');
    expect(stored).toMatchObject({
      siteType: 'office_retail',
      spotsPerRow: 4,
      rows: 2,
      chargersLeft: 1,
      chargersRight: 2,
    });
    expect(stored).not.toHaveProperty('chargers');
    expect(stored?.transformers).toHaveLength(1);
  });

  it('keeps a station with no free spot where it is and stores the shown counts of the old type', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '220', positionY: '20' },
      ],
      {
        settings: { sit_1: { ...small(4, 1), siteType: 'office_retail', chargers: 1 } },
        stations: { sit_1: ['sta_a', 'sta_b'] },
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', 'curbside');
    // The street splits the 2 stations: one on each curb.
    expect([change.settingsAfter.chargersLeft, change.settingsAfter.chargersRight]).toEqual([1, 1]);
    expect(change.moved).toEqual([{ stationId: 'sta_b', positionX: 20, positionY: 160 }]);
    expect(settings.get('sit_1')).toMatchObject({
      siteType: 'curbside',
      chargers: 1,
      mounting: 'wall',
    });
    expect(rows).toHaveLength(2);
    // Back to office: one charger position, the second station stays off the row.
    const back = await setSiteLayoutType(tx, 'sit_1', 'office_retail');
    expect(back.settingsAfter.chargers).toBe(1);
    expect(back.moved).toEqual([]);
    expect(rows.find((r) => r.stationId === 'sta_b')).toMatchObject({
      positionX: '20',
      positionY: '160',
    });
  });

  it('writes nothing when the site already has the type', async () => {
    const { tx, settings } = fakeTx([], { stations: { sit_1: [] } });
    const change = await setSiteLayoutType(tx, 'sit_1', 'parking_lot');
    expect(change.changed).toBe(false);
    expect(settings.has('sit_1')).toBe(false);
  });

  it('stores the type of a new site without stations, the office row following its stations', async () => {
    const { tx, settings } = fakeTx([], { settings: { sit_1: null }, stations: { sit_1: [] } });
    const change = await setSiteLayoutType(tx, 'sit_1', 'office_retail');
    expect(change.changed).toBe(true);
    expect(settings.get('sit_1')).toMatchObject({
      siteType: 'office_retail',
      spotsPerRow: 10,
      rows: 2,
    });
    expect(settings.get('sit_1')).not.toHaveProperty('chargers');
  });
});

describe('custom site free positions', () => {
  const custom: SiteLayoutSettings = {
    ...DEFAULT_LAYOUT_GRID,
    siteType: 'custom',
    transformers: [],
  };

  it('converts the slots to free positions where the stations stand, sliding overlapping ones', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_a', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '220', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_c', positionX: '20', positionY: '160' },
      ],
      {
        settings: { sit_1: null },
        stations: { sit_1: ['sta_a', 'sta_b', 'sta_c'] },
        evses: { sta_a: 2, sta_b: 2, sta_c: 1 },
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', 'custom');
    expect(change.changed).toBe(true);
    expect(settings.get('sit_1')).toMatchObject({ siteType: 'custom' });
    const free = (id: string) => {
      const r = rows.find((x) => x.stationId === id)!;
      return { x: Number(r.freeXM), z: Number(r.freeZM), rotationDeg: Number(r.freeRotationDeg) };
    };
    // Each charger 0.58 m behind its stall head line, the spots where they were.
    expect(free('sta_a')).toEqual({ x: 1.3, z: -0.58, rotationDeg: 0 });
    // Row 1 of the lot is turned.
    expect(free('sta_c')).toEqual({ x: 1.3, z: 18.88, rotationDeg: 180 });
    // Two spots each: sta_b slides right along its row until its spots are free.
    expect(free('sta_b').x).toBeGreaterThanOrEqual(1.3 + 5.2);
    expect(free('sta_b')).toMatchObject({ z: -0.58, rotationDeg: 0 });
    // The grid slots stay, so switching back returns the stations to them.
    expect(rows.find((x) => x.stationId === 'sta_b')).toMatchObject({ positionX: '220' });
    expect(change.moved.map((m) => m.stationId).sort()).toEqual(['sta_a', 'sta_b', 'sta_c']);
    const back = await setSiteLayoutType(tx, 'sit_1', 'parking_lot');
    expect(back.moved).toEqual([]);
  });

  it("refuses a sent position on another station's spots and writes nothing", async () => {
    const { tx, rows } = fakeTx(
      [
        {
          siteId: 'sit_1',
          stationId: 'sta_a',
          positionX: '20',
          positionY: '20',
          freeXM: '0',
          freeZM: '0',
          freeRotationDeg: '0',
        },
        {
          siteId: 'sit_1',
          stationId: 'sta_b',
          positionX: '220',
          positionY: '20',
          freeXM: '20',
          freeZM: '0',
          freeRotationDeg: '0',
        },
      ],
      { settings: { sit_1: custom }, stations: { sit_1: ['sta_a', 'sta_b'] } },
    );
    await expect(
      saveSiteLayout(tx, 'sit_1', [
        {
          stationId: 'sta_b',
          positionX: 220,
          positionY: 20,
          free: { x: 1, z: 0.5, rotationDeg: 30 },
        },
      ]),
    ).rejects.toMatchObject({ name: 'LayoutSpotsOverlapError', stations: ['CS-sta_b'] });
    expect(rows.find((r) => r.stationId === 'sta_b')).toMatchObject({ freeXM: '20' });
  });

  it('saves a free position with its turn and keeps the others', async () => {
    const { tx, rows } = fakeTx(
      [
        {
          siteId: 'sit_1',
          stationId: 'sta_a',
          positionX: '20',
          positionY: '20',
          freeXM: '0',
          freeZM: '0',
          freeRotationDeg: '0',
        },
        { siteId: 'sit_1', stationId: 'sta_b', positionX: '220', positionY: '20' },
      ],
      { settings: { sit_1: custom }, stations: { sit_1: ['sta_a', 'sta_b'] } },
    );
    const saved = await saveSiteLayout(tx, 'sit_1', [
      {
        stationId: 'sta_a',
        positionX: 20,
        positionY: 20,
        free: { x: -6.5, z: 3, rotationDeg: 345 },
      },
    ]);
    expect(rows.find((r) => r.stationId === 'sta_a')).toMatchObject({
      freeXM: '-6.5',
      freeZM: '3',
      freeRotationDeg: '345',
    });
    // A station of the site without a free position gets one, right of the others.
    expect(saved.moved).toHaveLength(1);
    expect(saved.moved[0]).toMatchObject({ stationId: 'sta_b' });
    expect(rows.find((r) => r.stationId === 'sta_b')!.freeXM).not.toBeNull();
  });

  it('places a new station of a custom site right of the others', async () => {
    const { tx, rows } = fakeTx(
      [
        {
          siteId: 'sit_1',
          stationId: 'sta_a',
          positionX: '20',
          positionY: '20',
          freeXM: '0',
          freeZM: '0',
          freeRotationDeg: '0',
        },
      ],
      { settings: { sit_1: custom }, evses: { sta_a: 2 } },
    );
    await placeStationOnLayout(tx, 'sit_1', 'sta_new');
    const row = rows.find((r) => r.stationId === 'sta_new')!;
    expect(Number(row.freeXM)).toBeGreaterThan(2.6);
    expect(row).toMatchObject({ freeRotationDeg: '0' });
  });
});

describe('AC and DC grouping', () => {
  // The default lot: 2 rows of 10, its transformer right of the first row.
  const lot: SiteLayoutSettings = {
    siteType: 'parking_lot',
    ...DEFAULT_LAYOUT_GRID,
    transformers: [{ id: 'tx-1', x: 30, z: 2.5 }],
  };

  it('places a new DC station next to the transformer and an AC station at the far end', async () => {
    const { tx } = fakeTx([], { settings: { sit_1: lot }, kinds: { dc1: 'dc', ac1: 'ac' } });
    // DC: the last spot of the first row (nearest the transformer).
    expect(await placeStationOnLayout(tx, 'sit_1', 'dc1')).toEqual({ x: 1820, y: 20 });
    // AC: the first spot of the far row.
    expect(await placeStationOnLayout(tx, 'sit_1', 'ac1')).toEqual({ x: 20, y: 160 });
    // A station whose connectors are not known yet takes the first free spot.
    expect(await placeStationOnLayout(tx, 'sit_1', 'new1')).toEqual({ x: 20, y: 20 });
  });

  it('regroups interleaved AC and DC stations when a site turns into an office or retail row', async () => {
    const ids = ['s0', 's1', 's2', 's3'];
    const { tx, rows } = fakeTx(
      ids.map((id, i) => ({
        siteId: 'sit_1',
        stationId: id,
        positionX: String(20 + 200 * i),
        positionY: '20',
      })),
      {
        settings: { sit_1: lot },
        stations: { sit_1: ids },
        kinds: { s0: 'dc', s1: 'ac', s2: 'dc', s3: 'ac' },
      },
    );
    await setSiteLayoutType(tx, 'sit_1', 'office_retail');
    const col = (id: string) =>
      (Number(rows.find((r) => r.stationId === id)!.positionX) - 20) / 200;
    const dcCols = [col('s0'), col('s2')];
    const acCols = [col('s1'), col('s3')];
    // Never interleaved: every DC spot lies past every AC spot (DC toward the transformer).
    expect(Math.min(...dcCols)).toBeGreaterThan(Math.max(...acCols));
  });
});

describe('parking lot charger placement', () => {
  const lot: SiteLayoutSettings = {
    siteType: 'parking_lot',
    spotsPerRow: 4,
    rows: 4,
    facingDeg: 0,
    transformers: [{ id: 'tx-1', x: 15, z: 2.5 }],
  };

  it('moves stations of the inner rows to the edge rows, DC nearest the transformer', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'dc1', positionX: '220', positionY: '160' },
        { siteId: 'sit_1', stationId: 'ac1', positionX: '420', positionY: '300' },
      ],
      {
        settings: { sit_1: lot },
        stations: { sit_1: ['dc1', 'ac1'] },
        kinds: { dc1: 'dc', ac1: 'ac' },
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', undefined, {
      chargerPlacement: 'lot_edge',
    });
    expect(change).toMatchObject({ changed: true, typeChanged: false, placementChanged: true });
    expect(settings.get('sit_1')).toMatchObject({
      siteType: 'parking_lot',
      chargerPlacement: 'lot_edge',
    });
    const at = (id: string) => {
      const r = rows.find((row) => row.stationId === id)!;
      return { x: Number(r.positionX), y: Number(r.positionY) };
    };
    // DC: the front edge row, at the transformer end (col 3); AC: the back edge row (row 3).
    expect(at('dc1')).toEqual({ x: 620, y: 20 });
    expect(at('ac1').y).toBe(440);
    // The same placement again writes nothing.
    const again = await setSiteLayoutType(tx, 'sit_1', undefined, { chargerPlacement: 'lot_edge' });
    expect(again.changed).toBe(false);
  });

  it('refuses a charger placement on another site type and drops it when the site leaves the parking lot', async () => {
    const { tx, settings } = fakeTx([], {
      settings: { sit_1: { ...lot, chargerPlacement: 'lot_edge' } },
      stations: { sit_1: [] },
    });
    await expect(
      setSiteLayoutType(tx, 'sit_1', 'curbside', { chargerPlacement: 'lot_edge' }),
    ).rejects.toBeInstanceOf(ChargerPlacementSiteTypeError);
    await setSiteLayoutType(tx, 'sit_1', 'office_retail');
    expect(settings.get('sit_1')).not.toHaveProperty('chargerPlacement');
  });
});

describe('depot site layout', () => {
  const depot: SiteLayoutSettings = {
    siteType: 'depot',
    ...DEFAULT_LAYOUT_GRID,
    transformers: [],
  };

  it('places a new truck station in the first free truck lane and a bus station in a bus bay', async () => {
    const { tx, rows } = fakeTx(
      [{ siteId: 'sit_1', stationId: 'sta_bus', positionX: '20', positionY: '20' }],
      { settings: { sit_1: { ...depot, busBays: 2, truckLanes: 2 } }, mcs: ['sta_truck'] },
    );
    // Row 1 is the truck lanes: slot (0, 1).
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_truck')).toEqual({ x: 20, y: 160 });
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_bus2')).toEqual({ x: 220, y: 20 });
    // A depot stores no free position.
    expect(rows.find((r) => r.stationId === 'sta_truck')?.freeXM).toBeUndefined();
  });

  it('never places an AC station in a bus bay or truck lane', async () => {
    const { tx } = fakeTx([], {
      settings: { sit_1: { ...depot, busBays: 2, truckLanes: 1 } },
      kinds: { sta_ac: 'ac', sta_dc: 'dc' },
    });
    // Below the layout (row 2), on the grass behind the yard.
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_ac')).toEqual({ x: 20, y: 300 });
    expect(await placeStationOnLayout(tx, 'sit_1', 'sta_dc')).toEqual({ x: 20, y: 20 });
  });

  it('moves an AC station out of a bay when a site turns into a depot', async () => {
    const { tx, rows } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_ac', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_dc', positionX: '220', positionY: '20' },
      ],
      {
        settings: { sit_1: { ...DEFAULT_LAYOUT_GRID, transformers: [] } },
        stations: { sit_1: ['sta_ac', 'sta_dc'] },
        kinds: { sta_ac: 'ac', sta_dc: 'dc' },
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', 'depot');
    // One bus bay for the DC station, none for the AC station.
    expect(change.settingsAfter).toMatchObject({ busBays: 1, truckLanes: 0 });
    const ac = rows.find((r) => r.stationId === 'sta_ac')!;
    expect(Number(ac.positionY)).toBeGreaterThanOrEqual(300);
    const dc = rows.find((r) => r.stationId === 'sta_dc')!;
    expect({ x: Number(dc.positionX), y: Number(dc.positionY) }).toEqual({ x: 20, y: 20 });
  });

  it('sorts the stations into bus bays and truck lanes when a site turns into a depot', async () => {
    const { tx, rows, settings } = fakeTx(
      [
        { siteId: 'sit_1', stationId: 'sta_t1', positionX: '20', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_b1', positionX: '220', positionY: '20' },
        { siteId: 'sit_1', stationId: 'sta_t2', positionX: '420', positionY: '20' },
      ],
      {
        settings: { sit_1: { ...DEFAULT_LAYOUT_GRID, transformers: [] } },
        stations: { sit_1: ['sta_t1', 'sta_b1', 'sta_t2'] },
        mcs: ['sta_t1', 'sta_t2'],
      },
    );
    const change = await setSiteLayoutType(tx, 'sit_1', 'depot');
    // One bus bay and two truck lanes from the stations' connectors.
    expect(change.settingsAfter).toMatchObject({ siteType: 'depot', busBays: 1, truckLanes: 2 });
    // The counts are not stored: they follow the stations until a layout Save.
    expect(settings.get('sit_1')?.busBays).toBeUndefined();
    const at = (id: string) => {
      const r = rows.find((row) => row.stationId === id)!;
      return { x: Number(r.positionX), y: Number(r.positionY) };
    };
    expect(at('sta_t1')).toEqual({ x: 20, y: 160 });
    expect(at('sta_b1')).toEqual({ x: 20, y: 20 });
    expect(at('sta_t2')).toEqual({ x: 220, y: 160 });
  });

  it('keeps stored depot counts through a switch to another type and back', async () => {
    const { tx, settings } = fakeTx([], {
      settings: { sit_1: { ...depot, busBays: 6, truckLanes: 3 } },
    });
    await setSiteLayoutType(tx, 'sit_1', 'parking_lot');
    expect(settings.get('sit_1')).toMatchObject({ busBays: 6, truckLanes: 3 });
    const back = await setSiteLayoutType(tx, 'sit_1', 'depot');
    expect(back.settingsAfter).toMatchObject({ busBays: 6, truckLanes: 3 });
  });
});

describe('boardOf', () => {
  it('reads a 2D board position only when both columns are stored', () => {
    expect(boardOf({ boardX: 480, boardY: -36 })).toEqual({ x: 480, y: -36 });
    expect(boardOf({ boardX: 0, boardY: 0 })).toEqual({ x: 0, y: 0 });
    expect(boardOf({ boardX: null, boardY: 12 })).toBeNull();
    expect(boardOf({})).toBeNull();
  });
});
