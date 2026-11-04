// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The energy asset writer: each asset write records the site
// load_management_changed audit row in the caller's name, a connection point
// must be of the site, simulated telemetry needs the process gate, and a
// reading is one upserted row with no audit.

const { state, writeAuditMock } = vi.hoisted(() => ({
  state: {
    results: [] as unknown[][],
    index: 0,
    ops: [] as Array<{ op: string; table: unknown; calls: Array<[string, unknown[]]> }>,
  },
  writeAuditMock: vi.fn(),
}));

function chainFor(op: string, table: unknown): Record<string, unknown> {
  const entry = { op, table, calls: [] as Array<[string, unknown[]]> };
  state.ops.push(entry);
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'where',
    'set',
    'values',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      entry.calls.push([m, args]);
      if (m === 'from') entry.table = args[0];
      return chain;
    });
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = state.results[state.index] ?? [];
    state.index++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

vi.mock('../config.js', () => ({
  db: {
    select: vi.fn(() => chainFor('select', null)),
    insert: vi.fn((t: unknown) => chainFor('insert', t)),
    update: vi.fn((t: unknown) => chainFor('update', t)),
    delete: vi.fn((t: unknown) => chainFor('delete', t)),
  },
}));

vi.mock('../lib/audit.js', () => ({ writeAudit: writeAuditMock }));

import {
  createEnergyAsset,
  deleteEnergyAsset,
  recordEnergyAssetReading,
  updateEnergyAsset,
} from '../lib/site-energy-assets.js';
import { LoadTreeValidationError } from '../lib/load-management-tree.js';
import {
  energyAssetReadings,
  panels,
  siteEnergyAssets,
  transformers,
} from '../schema/load-management.js';
import { siteAuditLog } from '../schema/audit.js';

const SITE = 'sit_1';
const CTX = { actor: 'operator' as const, actorUserId: 'usr_1' };
const ALLOW = { allowSimulated: true };
const DENY = { allowSimulated: false };

const BATTERY = {
  id: 'ena_1',
  siteId: SITE,
  type: 'battery' as 'battery' | 'solar',
  name: 'Storage',
  capacityKwh: 500 as number | null,
  peakKwp: null as number | null,
  inverterKw: '250' as string | null,
  maxDischargeKw: '200' as string | null,
  maxChargeKw: '150' as string | null,
  phases: 3,
  connectionTransformerId: null as string | null,
  connectionPanelId: 'pnl_1' as string | null,
  gridCharging: 'possible' as 'never' | 'possible',
  reservePercent: 10,
  telemetry: 'api' as 'none' | 'api' | 'simulated',
  readingTtlSeconds: 60,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function results(...r: unknown[][]): void {
  state.results = r;
  state.index = 0;
}

function auditArgs(n = 0): Record<string, unknown> {
  const call = writeAuditMock.mock.calls[n] as unknown[];
  expect(call[0]).toEqual({ table: siteAuditLog, idColumn: 'site_id' });
  return call[1] as Record<string, unknown>;
}

async function refusal(promise: Promise<unknown>): Promise<LoadTreeValidationError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LoadTreeValidationError);
  return err as LoadTreeValidationError;
}

function inserted(): Record<string, unknown> {
  const insert = state.ops.find((o) => o.op === 'insert');
  return insert?.calls.find(([m]) => m === 'values')?.[1][0] as Record<string, unknown>;
}

beforeEach(() => {
  state.ops = [];
  writeAuditMock.mockReset();
});

describe('energy assets', () => {
  it('creates an asset on a panel of the site and audits it', async () => {
    results([{ id: 'pnl_1', phases: 3 }], [BATTERY]);
    const created = await createEnergyAsset(BATTERY, CTX, DENY);
    expect(created).toEqual(BATTERY);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['select', panels],
      ['insert', siteEnergyAssets],
    ]);
    expect(auditArgs()).toMatchObject({
      entityId: SITE,
      action: 'load_management_changed',
      actorUserId: 'usr_1',
      before: null,
      after: { energyAsset: BATTERY },
      notes: 'energy asset created: Storage',
    });
  });

  it('stores solar as never charging from the grid', async () => {
    results([{ id: 'ena_2' }]);
    await createEnergyAsset(
      { siteId: SITE, type: 'solar', name: 'Canopy', peakKwp: 120 },
      CTX,
      DENY,
    );
    expect(inserted()).toMatchObject({ gridCharging: 'never' });
  });

  it('refuses a connection point of another site', async () => {
    results([]);
    const panel = await refusal(createEnergyAsset(BATTERY, CTX, DENY));
    expect(panel.field).toBe('connectionPanelId');
    results([]);
    const transformer = await refusal(
      createEnergyAsset(
        { ...BATTERY, connectionPanelId: null, connectionTransformerId: 'tfm_x' },
        CTX,
        DENY,
      ),
    );
    expect(transformer.field).toBe('connectionTransformerId');
    expect(state.ops.find((o) => o.op === 'select' && o.table === transformers)).toBeDefined();
    expect(state.ops.some((o) => o.op === 'insert')).toBe(false);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('refuses two connection points and fields of the other asset type', async () => {
    const both = await refusal(
      createEnergyAsset({ ...BATTERY, connectionTransformerId: 'tfm_1' }, CTX, DENY),
    );
    expect(both.field).toBe('connectionPanelId');
    const peak = await refusal(createEnergyAsset({ ...BATTERY, peakKwp: 100 }, CTX, DENY));
    expect(peak.field).toBe('peakKwp');
    const capacity = await refusal(
      createEnergyAsset(
        { siteId: SITE, type: 'solar', name: 'Canopy', capacityKwh: 100 },
        CTX,
        DENY,
      ),
    );
    expect(capacity.field).toBe('capacityKwh');
  });

  it('refuses simulated telemetry unless the process allows it', async () => {
    const denied = await refusal(
      createEnergyAsset({ ...BATTERY, telemetry: 'simulated' }, CTX, DENY),
    );
    expect(denied.field).toBe('telemetry');
    results([{ id: 'pnl_1', phases: 3 }], [{ ...BATTERY, telemetry: 'simulated' }]);
    expect(
      await createEnergyAsset({ ...BATTERY, telemetry: 'simulated' }, CTX, ALLOW),
    ).toMatchObject({ telemetry: 'simulated' });
    const switched = await refusal(
      updateEnergyAsset(
        { siteId: SITE, assetId: BATTERY.id, existing: BATTERY, set: { telemetry: 'simulated' } },
        CTX,
        DENY,
      ),
    );
    expect(switched.field).toBe('telemetry');
  });

  it('keeps stored simulated telemetry on an unrelated edit', async () => {
    const simulated = { ...BATTERY, telemetry: 'simulated' as const };
    results([{ ...simulated, name: 'Renamed' }]);
    const row = await updateEnergyAsset(
      { siteId: SITE, assetId: BATTERY.id, existing: simulated, set: { name: 'Renamed' } },
      CTX,
      DENY,
    );
    expect(row?.name).toBe('Renamed');
  });

  it('updates an asset, audits the changed fields and notes a telemetry change', async () => {
    results([{ ...BATTERY, telemetry: 'none', reservePercent: 20 }]);
    await updateEnergyAsset(
      {
        siteId: SITE,
        assetId: BATTERY.id,
        existing: BATTERY,
        set: { telemetry: 'none', reservePercent: 20 },
      },
      CTX,
      DENY,
    );
    // The connection point did not change: not read again.
    expect(state.ops.map((o) => o.op)).toEqual(['update']);
    expect(auditArgs()).toMatchObject({
      before: { energyAssetId: BATTERY.id, telemetry: 'api', reservePercent: 10 },
      after: { energyAssetId: BATTERY.id, telemetry: 'none', reservePercent: 20 },
      notes: 'energy asset updated: Storage (telemetry api to none)',
    });
  });

  it('checks a new connection point on update', async () => {
    results([]);
    const err = await refusal(
      updateEnergyAsset(
        {
          siteId: SITE,
          assetId: BATTERY.id,
          existing: BATTERY,
          set: { connectionPanelId: null, connectionTransformerId: 'tfm_other' },
        },
        CTX,
        DENY,
      ),
    );
    expect(err.field).toBe('connectionTransformerId');
  });

  it('refuses a three-phase asset at a single-phase panel or transformer', async () => {
    results([{ id: 'pnl_1', phases: 1 }]);
    const panel = await refusal(createEnergyAsset(BATTERY, CTX, DENY));
    expect(panel.field).toBe('phases');
    results([{ id: 'tfm_1', phases: 1 }]);
    const transformer = await refusal(
      createEnergyAsset(
        { ...BATTERY, connectionPanelId: null, connectionTransformerId: 'tfm_1' },
        CTX,
        DENY,
      ),
    );
    expect(transformer.field).toBe('phases');
    expect(state.ops.some((o) => o.op === 'insert')).toBe(false);
    // A single-phase asset connects there.
    results([{ id: 'pnl_1', phases: 1 }], [{ ...BATTERY, phases: 1 }]);
    expect(await createEnergyAsset({ ...BATTERY, phases: 1 }, CTX, DENY)).toMatchObject({
      phases: 1,
    });
  });

  it('checks the connection point again when the phases change', async () => {
    results([{ id: 'pnl_1', phases: 1 }]);
    const err = await refusal(
      updateEnergyAsset(
        {
          siteId: SITE,
          assetId: BATTERY.id,
          existing: { ...BATTERY, phases: 1 },
          set: { phases: 3 },
        },
        CTX,
        DENY,
      ),
    );
    expect(err.field).toBe('phases');
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([['select', panels]]);
  });

  it('refuses a connected grid-charging battery without a charge or inverter rating', async () => {
    const unrated = { ...BATTERY, maxChargeKw: null, inverterKw: null };
    const created = await refusal(createEnergyAsset(unrated, CTX, DENY));
    expect(created.field).toBe('maxChargeKw');
    expect(state.ops.length).toBe(0);
    // A rating removed later.
    const removed = await refusal(
      updateEnergyAsset(
        {
          siteId: SITE,
          assetId: BATTERY.id,
          existing: BATTERY,
          set: { maxChargeKw: null, inverterKw: null },
        },
        CTX,
        DENY,
      ),
    );
    expect(removed.field).toBe('maxChargeKw');
    // A connection added later to an unrated battery.
    const unconnected = { ...unrated, connectionPanelId: null };
    const connected = await refusal(
      updateEnergyAsset(
        {
          siteId: SITE,
          assetId: BATTERY.id,
          existing: unconnected,
          set: { connectionPanelId: 'pnl_1' },
        },
        CTX,
        DENY,
      ),
    );
    expect(connected.field).toBe('maxChargeKw');
    expect(state.ops.some((o) => o.op === 'update')).toBe(false);
  });

  it('keeps an unconnected or never grid-charging battery without a rating', async () => {
    const unrated = { ...BATTERY, maxChargeKw: null, inverterKw: null };
    results([{ ...unrated, connectionPanelId: null }]);
    expect(
      await createEnergyAsset({ ...unrated, connectionPanelId: null }, CTX, DENY),
    ).toMatchObject({ connectionPanelId: null });
    results([{ id: 'pnl_1', phases: 3 }], [{ ...unrated, gridCharging: 'never' }]);
    expect(await createEnergyAsset({ ...unrated, gridCharging: 'never' }, CTX, DENY)).toMatchObject(
      { gridCharging: 'never' },
    );
    // The inverter rating alone bounds the load.
    results([{ id: 'pnl_1', phases: 3 }], [{ ...unrated, inverterKw: '100' }]);
    expect(await createEnergyAsset({ ...unrated, inverterKw: '100' }, CTX, DENY)).toMatchObject({
      inverterKw: '100',
    });
  });

  it('returns null without an audit when the asset is gone', async () => {
    results([]);
    expect(
      await updateEnergyAsset({ siteId: SITE, assetId: 'ena_x', set: { name: 'Y' } }, CTX, DENY),
    ).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('deletes an asset and audits it', async () => {
    results([]);
    await deleteEnergyAsset({ siteId: SITE, asset: BATTERY }, CTX);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([['delete', siteEnergyAssets]]);
    expect(auditArgs()).toMatchObject({
      before: { energyAsset: BATTERY },
      after: null,
      notes: 'energy asset deleted: Storage',
    });
  });
});

describe('energy asset readings', () => {
  it('upserts one row per asset, keeps the API key and writes no audit row', async () => {
    results([{ assetId: BATTERY.id }]);
    const reportedAt = new Date('2026-11-03T12:00:00Z');
    const stored = await recordEnergyAssetReading({
      assetId: BATTERY.id,
      reportedAt,
      powerKw: 42.5,
      availableKw: 80,
      socPercent: 64,
      source: 'api',
      apiKeyId: '17',
    });
    expect(stored).toBe(true);
    const insert = state.ops[0];
    expect(insert?.table).toBe(energyAssetReadings);
    expect(insert?.calls.find(([m]) => m === 'values')?.[1][0]).toMatchObject({
      assetId: BATTERY.id,
      reportedAt,
      powerKw: '42.5',
      availableKw: '80',
      socPercent: '64',
      source: 'api',
      apiKeyId: '17',
    });
    const upsert = insert?.calls.find(([m]) => m === 'onConflictDoUpdate')?.[1][0] as {
      target: unknown;
      setWhere: unknown;
    };
    expect(upsert.target).toBe(energyAssetReadings.assetId);
    // An older reading never replaces a newer one.
    expect(upsert.setWhere).toBeDefined();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('stores a reading dated after its arrival as measured when it arrived (case 333)', async () => {
    results([{ assetId: BATTERY.id }]);
    const receivedAt = new Date('2026-11-03T12:00:00Z');
    await recordEnergyAssetReading({
      assetId: BATTERY.id,
      reportedAt: new Date('2026-11-03T12:00:25Z'),
      receivedAt,
      powerKw: 10,
      availableKw: null,
      socPercent: null,
      source: 'api',
      apiKeyId: null,
    });
    expect(state.ops[0]?.calls.find(([m]) => m === 'values')?.[1][0]).toMatchObject({
      reportedAt: receivedAt,
      receivedAt,
    });
  });

  it('reports a reading the newer stored one kept out', async () => {
    results([]);
    expect(
      await recordEnergyAssetReading({
        assetId: BATTERY.id,
        reportedAt: new Date('2026-11-03T11:00:00Z'),
        powerKw: 10,
        availableKw: null,
        socPercent: null,
        source: 'api',
        apiKeyId: null,
      }),
    ).toBe(false);
  });
});
