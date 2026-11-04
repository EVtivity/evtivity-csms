// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The load management tree writer: each panel and circuit write records the
// site load_management_changed audit row in the caller's name, and writes
// nothing more when no row was written.

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
  for (const m of ['from', 'where', 'set', 'values', 'returning', 'onConflictDoNothing']) {
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
  createCircuit,
  createPanel,
  createTransformer,
  deleteCircuit,
  deletePanel,
  deleteTransformer,
  LoadTreeValidationError,
  updateCircuit,
  updatePanel,
  updateTransformer,
} from '../lib/load-management-tree.js';
import { circuits, panels, transformers } from '../schema/load-management.js';
import { chargingStations } from '../schema/assets.js';
import { siteAuditLog } from '../schema/audit.js';
import { db } from '../config.js';

const SITE = 'sit_1';
const CTX = { actor: 'operator' as const, actorUserId: 'usr_1' };

const PANEL = {
  id: 'pnl_1',
  siteId: SITE,
  parentPanelId: null,
  name: 'Main',
  breakerRatingAmps: 200,
  voltageV: 240,
  phases: 1,
  phaseConnections: null,
  maxContinuousKw: '38.4',
  safetyMarginKw: '0',
  oversubscriptionRatio: '1.0',
  transformerId: null,
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const CIRCUIT = {
  id: 'cir_1',
  panelId: 'pnl_1',
  name: 'C1',
  breakerRatingAmps: 40,
  maxContinuousKw: '7.68',
  phaseConnections: null,
  voltageV: null as number | null,
  sortOrder: 0,
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

beforeEach(() => {
  state.ops = [];
  writeAuditMock.mockReset();
  vi.mocked(db.insert).mockClear();
});

describe('panels', () => {
  it('creates a panel and audits it in the caller name', async () => {
    results([PANEL]);
    const created = await createPanel({ siteId: SITE, name: 'Main' } as never, CTX);
    expect(created).toEqual(PANEL);
    expect(state.ops[0]?.table).toBe(panels);
    expect(state.ops[0]?.calls.some(([m]) => m === 'onConflictDoNothing')).toBe(false);
    expect(auditArgs()).toMatchObject({
      entityId: SITE,
      entityIdSnapshot: SITE,
      action: 'load_management_changed',
      actor: 'operator',
      actorUserId: 'usr_1',
      before: null,
      after: { panel: PANEL },
      notes: 'panel created: Main',
    });
  });

  it('writes nothing and audits nothing when ifMissing finds the id taken', async () => {
    results([]);
    const created = await createPanel(PANEL, { actor: 'system' }, { ifMissing: true });
    expect(created).toBeNull();
    expect(state.ops[0]?.calls.some(([m]) => m === 'onConflictDoNothing')).toBe(true);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('updates a panel and audits only the changed fields', async () => {
    const updated = { ...PANEL, name: 'Main 2', updatedAt: new Date() };
    results([updated]);
    const row = await updatePanel(
      { siteId: SITE, panelId: PANEL.id, existing: PANEL, set: { name: 'Main 2' } },
      CTX,
    );
    expect(row).toEqual(updated);
    expect(state.ops).toHaveLength(1);
    expect(auditArgs()).toMatchObject({
      before: { panelId: PANEL.id, name: 'Main' },
      after: { panelId: PANEL.id, name: 'Main 2' },
      notes: 'panel updated: Main 2',
    });
  });

  it('recomputes the circuits and clears sub-panel phases when asked', async () => {
    const updated = { ...PANEL, voltageV: 208, phases: 1 };
    results([updated], [{ ...CIRCUIT, voltageV: 240 }], [], []);
    await updatePanel(
      {
        siteId: SITE,
        panelId: PANEL.id,
        existing: PANEL,
        set: { voltageV: 208 },
        recomputeCircuits: true,
        clearSubPanelPhases: true,
      },
      CTX,
    );
    const circuitUpdate = state.ops.find((o) => o.op === 'update' && o.table === circuits);
    const set = circuitUpdate?.calls.find(([m]) => m === 'set')?.[1][0] as Record<string, unknown>;
    // 240 V no longer fits a 208 V panel: cleared, the circuit runs at 208 V.
    expect(set).toMatchObject({ voltageV: null, maxContinuousKw: expect.any(String) });
    const subPanels = state.ops.filter((o) => o.op === 'update' && o.table === panels);
    expect(subPanels).toHaveLength(2);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('reads the row, applies onlyIf and audits nothing when no row changed', async () => {
    results([PANEL], []);
    const row = await updatePanel(
      { siteId: SITE, panelId: PANEL.id, set: { name: 'X' }, onlyIf: undefined },
      { actor: 'system', notes: 'seed' },
    );
    expect(row).toBeNull();
    expect(state.ops.map((o) => o.op)).toEqual(['select', 'update']);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('uses the notes override', async () => {
    results([PANEL], [{ ...PANEL, name: 'Y' }]);
    await updatePanel(
      { siteId: SITE, panelId: PANEL.id, set: { name: 'Y' } },
      { actor: 'system', notes: 'Site layout demo: moved' },
    );
    expect(auditArgs()).toMatchObject({ actor: 'system', notes: 'Site layout demo: moved' });
  });

  it('deletes a panel after unassigning the stations of its circuits', async () => {
    results([{ id: 'cir_1' }, { id: 'cir_2' }], [{ id: 'tfm_sd' }], [], [], []);
    await deletePanel({ siteId: SITE, panel: PANEL }, CTX);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['select', circuits],
      ['select', transformers],
      ['update', chargingStations],
      ['update', chargingStations],
      ['delete', panels],
    ]);
    // The step-down units the panel fed go with it (foreign key cascade).
    expect(auditArgs()).toMatchObject({
      before: { panel: PANEL, circuitIds: ['cir_1', 'cir_2'], stepDownTransformerIds: ['tfm_sd'] },
      after: null,
      notes: 'panel deleted: Main',
    });
  });
});

describe('circuits', () => {
  it('creates a circuit and audits it on the site', async () => {
    results([CIRCUIT]);
    const created = await createCircuit(SITE, { panelId: 'pnl_1', name: 'C1' } as never, CTX);
    expect(created).toEqual(CIRCUIT);
    expect(auditArgs()).toMatchObject({
      entityId: SITE,
      after: { circuit: CIRCUIT },
      notes: 'circuit created: C1',
    });
  });

  it('skips the audit when ifMissing finds the id taken', async () => {
    results([]);
    expect(await createCircuit(SITE, CIRCUIT, CTX, { ifMissing: true })).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('updates a circuit and audits the changed fields', async () => {
    results([{ ...CIRCUIT, breakerRatingAmps: 50 }]);
    await updateCircuit(
      { siteId: SITE, circuitId: 'cir_1', existing: CIRCUIT, set: { breakerRatingAmps: 50 } },
      CTX,
    );
    expect(auditArgs()).toMatchObject({
      before: { circuitId: 'cir_1', breakerRatingAmps: 40 },
      after: { circuitId: 'cir_1', breakerRatingAmps: 50 },
      notes: 'circuit updated: C1',
    });
  });

  it('returns null without an audit when the circuit is gone', async () => {
    results([]);
    expect(await updateCircuit({ siteId: SITE, circuitId: 'x', set: {} }, CTX)).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('deletes a circuit after unassigning its stations', async () => {
    results([], []);
    await deleteCircuit({ siteId: SITE, circuit: { id: 'cir_1', name: 'C1' } }, CTX);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['update', chargingStations],
      ['delete', circuits],
    ]);
    expect(auditArgs()).toMatchObject({
      before: { circuit: { id: 'cir_1', name: 'C1' } },
      after: null,
      notes: 'circuit deleted: C1',
    });
  });
});

const SERVICE = {
  id: 'tfm_1',
  siteId: SITE,
  kind: 'service' as 'service' | 'step_down',
  name: 'Utility',
  ratedKva: '1000' as string | null,
  phases: 3,
  secondaryVoltageV: 277 as number | null,
  powerFactor: '0.95',
  loadingLimitPercent: 100,
  safetyMarginKw: '0',
  fedFromPanelId: null as string | null,
  maxContinuousKw: '950' as string | null,
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const STEP_DOWN = {
  ...SERVICE,
  id: 'tfm_2',
  kind: 'step_down' as 'service' | 'step_down',
  name: 'Step Down',
  ratedKva: '75' as string | null,
  secondaryVoltageV: 120,
  fedFromPanelId: 'pnl_1' as string | null,
  maxContinuousKw: '71.25' as string | null,
};
const SUB_PANEL = {
  ...PANEL,
  id: 'pnl_2',
  parentPanelId: 'pnl_1' as string | null,
  name: 'L2 Panel',
};

function transformerValues(row: typeof SERVICE): Omit<typeof SERVICE, 'maxContinuousKw'> {
  const values: Partial<typeof SERVICE> = { ...row };
  delete values.maxContinuousKw;
  return values as Omit<typeof SERVICE, 'maxContinuousKw'>;
}

function insertedValues(): Record<string, unknown> {
  const insert = state.ops.find((o) => o.op === 'insert');
  return insert?.calls.find(([m]) => m === 'values')?.[1][0] as Record<string, unknown>;
}

function updateSet(table: unknown): Record<string, unknown> | undefined {
  const update = state.ops.find((o) => o.op === 'update' && o.table === table);
  return update?.calls.find(([m]) => m === 'set')?.[1][0] as Record<string, unknown> | undefined;
}

async function refusal(promise: Promise<unknown>): Promise<LoadTreeValidationError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LoadTreeValidationError);
  return err as LoadTreeValidationError;
}

describe('transformers', () => {
  it('stores the capacity of a 1000 kVA transformer at 0.95 and audits it', async () => {
    results([SERVICE]);
    const created = await createTransformer(transformerValues(SERVICE), CTX);
    expect(created).toEqual(SERVICE);
    expect(insertedValues()).toMatchObject({ maxContinuousKw: '950' });
    expect(auditArgs()).toMatchObject({
      entityId: SITE,
      action: 'load_management_changed',
      actorUserId: 'usr_1',
      before: null,
      after: { transformer: SERVICE },
      notes: 'transformer created: Utility',
    });
  });

  it('stores no capacity for an unrated transformer', async () => {
    results([{ ...SERVICE, ratedKva: null, maxContinuousKw: null }]);
    await createTransformer(
      { siteId: SITE, kind: 'service', name: 'Unrated', ratedKva: null },
      CTX,
    );
    expect(insertedValues()).toMatchObject({ maxContinuousKw: null });
  });

  it('writes nothing and audits nothing when ifMissing finds the id taken', async () => {
    results([]);
    expect(
      await createTransformer(transformerValues(SERVICE), { actor: 'system' }, { ifMissing: true }),
    ).toBeNull();
    expect(state.ops[0]?.calls.some(([m]) => m === 'onConflictDoNothing')).toBe(true);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('refuses a step-down unit without a feeding panel or fed from another site', async () => {
    const noFeed = await refusal(
      createTransformer({ siteId: SITE, kind: 'step_down', name: 'X', ratedKva: '75' }, CTX),
    );
    expect(noFeed.field).toBe('fedFromPanelId');
    results([]);
    const foreign = await refusal(
      createTransformer(
        { siteId: SITE, kind: 'step_down', name: 'X', ratedKva: '75', fedFromPanelId: 'pnl_x' },
        CTX,
      ),
    );
    expect(foreign.field).toBe('fedFromPanelId');
    const fedService = await refusal(
      createTransformer(
        { siteId: SITE, kind: 'service', name: 'X', ratedKva: '75', fedFromPanelId: 'pnl_1' },
        CTX,
      ),
    );
    expect(fedService.field).toBe('fedFromPanelId');
    expect(state.ops.some((o) => o.op === 'insert')).toBe(false);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('recomputes the capacity when the loading limit changes', async () => {
    const updated = { ...SERVICE, loadingLimitPercent: 80, maxContinuousKw: '760' };
    results([updated]);
    await updateTransformer(
      {
        siteId: SITE,
        transformerId: SERVICE.id,
        existing: SERVICE,
        set: { loadingLimitPercent: 80 },
      },
      CTX,
    );
    expect(updateSet(transformers)).toMatchObject({
      loadingLimitPercent: 80,
      maxContinuousKw: '760',
    });
    expect(auditArgs()).toMatchObject({
      before: { transformerId: SERVICE.id, loadingLimitPercent: 100, maxContinuousKw: '950' },
      after: { transformerId: SERVICE.id, loadingLimitPercent: 80, maxContinuousKw: '760' },
      notes: 'transformer updated: Utility',
    });
  });

  it('refuses to unrate a transformer that feeds a panel', async () => {
    results([{ id: PANEL.id, parentPanelId: null }]);
    const unrated = await refusal(
      updateTransformer(
        { siteId: SITE, transformerId: SERVICE.id, existing: SERVICE, set: { ratedKva: null } },
        CTX,
      ),
    );
    expect(unrated.field).toBe('ratedKva');
    expect(state.ops.some((o) => o.op === 'update')).toBe(false);
  });

  it('refuses to make a transformer that feeds a top-level panel a step-down unit', async () => {
    results([{ id: 'pnl_9', parentPanelId: null }], [{ id: PANEL.id, parentPanelId: null }]);
    const kind = await refusal(
      updateTransformer(
        {
          siteId: SITE,
          transformerId: SERVICE.id,
          existing: SERVICE,
          set: { kind: 'step_down', fedFromPanelId: 'pnl_9' },
        },
        CTX,
      ),
    );
    expect(kind.field).toBe('kind');
    expect(state.ops.some((o) => o.op === 'update')).toBe(false);
  });

  it('returns null without an audit when the transformer is gone', async () => {
    results([]);
    expect(
      await updateTransformer({ siteId: SITE, transformerId: 'tfm_x', set: { name: 'Y' } }, CTX),
    ).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('unlinks its panels before it deletes a transformer', async () => {
    results([{ id: PANEL.id }], []);
    await deleteTransformer({ siteId: SITE, transformer: SERVICE }, CTX);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['update', panels],
      ['delete', transformers],
    ]);
    expect(updateSet(panels)).toMatchObject({ transformerId: null });
    expect(auditArgs()).toMatchObject({
      before: { transformer: SERVICE, panelIds: [PANEL.id] },
      after: null,
      notes: 'transformer deleted: Utility',
    });
  });
});

describe('panel transformer links', () => {
  it('links a top-level panel to a rated service transformer of the site', async () => {
    const updated = { ...PANEL, transformerId: SERVICE.id };
    results([SERVICE], [updated]);
    await updatePanel(
      { siteId: SITE, panelId: PANEL.id, existing: PANEL, set: { transformerId: SERVICE.id } },
      CTX,
    );
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['select', transformers],
      ['update', panels],
    ]);
    expect(auditArgs()).toMatchObject({
      before: { panelId: PANEL.id, transformerId: null },
      after: { panelId: PANEL.id, transformerId: SERVICE.id },
    });
  });

  it('links a sub-panel to the step-down unit fed from its parent', async () => {
    results([STEP_DOWN], [{ ...SUB_PANEL, transformerId: STEP_DOWN.id }]);
    const row = await updatePanel(
      {
        siteId: SITE,
        panelId: SUB_PANEL.id,
        existing: SUB_PANEL,
        set: { transformerId: STEP_DOWN.id },
      },
      CTX,
    );
    expect(row?.transformerId).toBe(STEP_DOWN.id);
  });

  it('clears a link without a lookup', async () => {
    const linked = { ...PANEL, transformerId: SERVICE.id };
    results([{ ...PANEL, transformerId: null }]);
    await updatePanel(
      { siteId: SITE, panelId: PANEL.id, existing: linked, set: { transformerId: null } },
      CTX,
    );
    expect(state.ops.map((o) => o.op)).toEqual(['update']);
  });

  it('refuses a transformer of another site, an unrated one and a wrong kind', async () => {
    const cases: Array<[unknown[], typeof SUB_PANEL]> = [
      [[], PANEL],
      [[{ ...SERVICE, ratedKva: null, maxContinuousKw: null }], PANEL],
      [[SERVICE], SUB_PANEL],
      [[STEP_DOWN], PANEL],
      [[{ ...STEP_DOWN, fedFromPanelId: 'pnl_9' }], SUB_PANEL],
    ];
    for (const [lookup, panel] of cases) {
      state.ops = [];
      results(lookup);
      const err = await refusal(
        updatePanel(
          { siteId: SITE, panelId: panel.id, existing: panel, set: { transformerId: 'tfm_any' } },
          CTX,
        ),
      );
      expect(err.field).toBe('transformerId');
      expect(state.ops.some((o) => o.op === 'update')).toBe(false);
    }
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('checks the link again when a linked sub-panel moves to another parent', async () => {
    const linked = { ...SUB_PANEL, transformerId: STEP_DOWN.id };
    results([STEP_DOWN]);
    const err = await refusal(
      updatePanel(
        { siteId: SITE, panelId: linked.id, existing: linked, set: { parentPanelId: 'pnl_3' } },
        CTX,
      ),
    );
    expect(err.field).toBe('transformerId');
  });

  it('refuses a new panel linked to a transformer it cannot take', async () => {
    results([SERVICE]);
    const err = await refusal(
      createPanel(
        { siteId: SITE, name: 'Sub', parentPanelId: 'pnl_1', transformerId: SERVICE.id } as never,
        CTX,
      ),
    );
    expect(err.field).toBe('transformerId');
    expect(state.ops.some((o) => o.op === 'insert')).toBe(false);
  });
});
