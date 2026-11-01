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
  deleteCircuit,
  deletePanel,
  updateCircuit,
  updatePanel,
} from '../lib/load-management-tree.js';
import { circuits, panels } from '../schema/load-management.js';
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
    results([{ id: 'cir_1' }, { id: 'cir_2' }], [], [], []);
    await deletePanel({ siteId: SITE, panel: PANEL }, CTX);
    expect(state.ops.map((o) => [o.op, o.table])).toEqual([
      ['select', circuits],
      ['update', chargingStations],
      ['update', chargingStations],
      ['delete', panels],
    ]);
    expect(auditArgs()).toMatchObject({
      before: { panel: PANEL, circuitIds: ['cir_1', 'cir_2'] },
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
