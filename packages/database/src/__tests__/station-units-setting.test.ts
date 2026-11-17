// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  where: vi.fn(),
  warn: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../config.js', () => ({ db: { select: h.select, transaction: h.transaction } }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
vi.mock('../schema/assets.js', () => ({ chargingStations: { usesUnits: 'uses_units' } }));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ col, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn: h.warn }) }));

function settingRows(rows: unknown[]): void {
  h.where.mockImplementation(() => Promise.resolve(rows));
  h.select.mockReturnValue({ from: () => ({ where: h.where }) });
}

/** A transaction whose selects answer `answers` in order and records its writes. */
function fakeTx(answers: unknown[][]): {
  tx: Record<string, unknown>;
  writes: string[];
  locks: unknown[];
} {
  const writes: string[] = [];
  const locks: unknown[] = [];
  const returning = (row: unknown) => ({ returning: () => Promise.resolve([row]) });
  const tx = {
    execute: vi.fn((q: unknown) => {
      locks.push(q);
      return Promise.resolve([]);
    }),
    select: vi.fn(() => ({
      from: () => ({ where: () => Promise.resolve(answers.shift() ?? []) }),
    })),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          writes.push(`insert:${String(v['value'])}`);
          return returning({ key: 'stationUnits.enabled', value: v['value'] });
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          writes.push(`update:${String(v['value'])}`);
          return returning({ key: 'stationUnits.enabled', value: v['value'] });
        },
      }),
    })),
  };
  return { tx, writes, locks };
}

const MODULE = '../lib/station-units-setting.js';

beforeAll(async () => {
  await import(MODULE);
}, 30_000);

beforeEach(() => {
  vi.resetModules();
  h.select.mockReset();
  h.where.mockReset();
  h.warn.mockReset();
  h.transaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isStationUnitsFeatureEnabled', () => {
  it('names the setting key', async () => {
    const mod = await import(MODULE);
    expect(mod.STATION_UNITS_SETTING_KEY).toBe('stationUnits.enabled');
  });

  it('is off when the row is missing', async () => {
    const mod = await import(MODULE);
    settingRows([]);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(false);
  });

  it.each([
    [true, true],
    [false, false],
    ['true', false],
    [1, false],
    [null, false],
  ])('reads the stored value %j as %j', async (value, expected) => {
    const mod = await import(MODULE);
    settingRows([{ value }]);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(expected);
  });

  it('reads the database once within 60 seconds, and again after the cache is cleared or expires', async () => {
    vi.useFakeTimers();
    const mod = await import(MODULE);
    settingRows([{ value: true }]);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(true);
    settingRows([{ value: false }]);
    vi.advanceTimersByTime(59_000);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(1);
    mod.clearStationUnitsFeatureCache();
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(false);
    settingRows([{ value: true }]);
    vi.advanceTimersByTime(61_000);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(true);
  });

  it('fails closed: a read error with no cached value counts as off, and keeps a cached value', async () => {
    vi.useFakeTimers();
    const mod = await import(MODULE);
    h.where.mockImplementation(() => Promise.reject(new Error('connection lost')));
    h.select.mockReturnValue({ from: () => ({ where: h.where }) });
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(false);
    expect(h.warn).toHaveBeenCalledTimes(1);

    settingRows([{ value: true }]);
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(true);
    vi.advanceTimersByTime(61_000);
    h.where.mockImplementation(() => Promise.reject(new Error('connection lost')));
    expect(await mod.isStationUnitsFeatureEnabled()).toBe(true);
  });
});

describe('writeStationUnitsSetting', () => {
  it('refuses off while stations use units, under the lock, and writes nothing', async () => {
    const mod = await import(MODULE);
    const { tx, writes, locks } = fakeTx([[{ n: 2 }]]);
    h.transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    expect(await mod.writeStationUnitsSetting(false, 'upsert')).toEqual({
      ok: false,
      reason: 'in_use',
      stationCount: 2,
    });
    expect(locks).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('turns it off when no station uses units', async () => {
    const mod = await import(MODULE);
    const { tx, writes } = fakeTx([[{ n: 0 }], [{ key: 'stationUnits.enabled', value: true }]]);
    h.transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    const result = await mod.writeStationUnitsSetting(false, 'upsert');
    expect(result).toMatchObject({ ok: true, row: { value: false } });
    expect(writes).toEqual(['insert:false']);
  });

  it('turns it on without counting stations', async () => {
    const mod = await import(MODULE);
    const { tx, writes } = fakeTx([[{ key: 'stationUnits.enabled', value: false }]]);
    h.transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    const result = await mod.writeStationUnitsSetting(true, 'update');
    expect(result).toMatchObject({ ok: true, before: { value: false }, row: { value: true } });
    expect(writes).toEqual(['update:true']);
  });

  it('answers not_found for an update of a missing row', async () => {
    const mod = await import(MODULE);
    const { tx, writes } = fakeTx([[]]);
    h.transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    expect(await mod.writeStationUnitsSetting(true, 'update')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(writes).toEqual([]);
  });
});

describe('stationUnitsFeatureOnInTx', () => {
  it('takes the shared lock and reads the stored value fresh', async () => {
    const mod = await import(MODULE);
    const { tx, locks } = fakeTx([[{ value: true }], []]);
    expect(await mod.stationUnitsFeatureOnInTx(tx as never)).toBe(true);
    expect(await mod.stationUnitsFeatureOnInTx(tx as never)).toBe(false);
    expect(locks).toHaveLength(2);
  });
});
