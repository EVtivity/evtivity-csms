// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    'innerJoin',
    'for',
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

vi.mock('../config.js', () => {
  const db: Record<string, unknown> = {
    select: vi.fn(() => chainFor('select', null)),
    insert: vi.fn((t: unknown) => chainFor('insert', t)),
    update: vi.fn((t: unknown) => chainFor('update', t)),
    delete: vi.fn((t: unknown) => chainFor('delete', t)),
  };
  db['transaction'] = vi.fn((work: (tx: unknown) => Promise<unknown>) => work(db));
  return { db };
});

vi.mock('../lib/audit.js', () => ({ writeAudit: writeAuditMock }));

import { clearUnitLoadBudget, setUnitLoadBudget } from '../lib/load-management-unit-budgets.js';
import { LoadTreeValidationError } from '../lib/load-management-tree.js';
import { stationUnitLoadBudgets } from '../schema/load-management.js';

const SITE = 'sit_1';
const STATION = 'sta_1';
const UNIT = 'unt_1';
const CTX = { actor: 'operator' as const, actorUserId: 'usr_1' };
const INPUT = { siteId: SITE, stationId: STATION, unitId: UNIT };

const type2 = (evseId: string) => ({ evseId, connectorType: 'Type2', maxPowerKw: '22' });
const ccs = (evseId: string) => ({ evseId, connectorType: 'CCS2', maxPowerKw: '150' });

const acRow = (over: Record<string, unknown> = {}) => ({
  unitId: UNIT,
  stationId: STATION,
  kind: 'ac',
  maxCurrentA: '32.0',
  phases: 3,
  maxPowerKw: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  state.results = [];
  state.index = 0;
  state.ops = [];
  writeAuditMock.mockReset();
});

describe('setUnitLoadBudget', () => {
  it('stores an AC budget with the circuit phases and audits it', async () => {
    state.results = [
      [{ circuitId: 'cir_1' }],
      [{ name: 'Box 1' }],
      [type2('evs_1'), type2('evs_2')],
      [{ phaseConnections: null, panelPhases: 3 }],
      [],
      [acRow()],
    ];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'ac', maxCurrentA: 32 } },
      CTX,
    );
    expect(result).toEqual({
      ok: true,
      changed: true,
      budget: {
        unitId: UNIT,
        stationId: STATION,
        kind: 'ac',
        maxCurrentA: 32,
        phases: 3,
        maxPowerKw: null,
      },
    });
    const insert = state.ops.find((o) => o.op === 'insert');
    expect(insert?.table).toBe(stationUnitLoadBudgets);
    const values = insert?.calls.find(([m]) => m === 'values')?.[1][0];
    expect(values).toMatchObject({ kind: 'ac', maxCurrentA: '32.0', phases: 3, maxPowerKw: null });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(audit).toMatchObject({
      entityId: SITE,
      action: 'load_management_changed',
      before: { unitBudget: null },
      notes: 'unit load budget set: Box 1',
    });
  });

  it('takes one phase on a single-phase circuit', async () => {
    state.results = [
      [{ circuitId: 'cir_1' }],
      [{ name: 'Box 1' }],
      [type2('evs_1')],
      [{ phaseConnections: 'L1', panelPhases: 3 }],
      [],
      [acRow({ phases: 1 })],
    ];
    await setUnitLoadBudget({ ...INPUT, budget: { kind: 'ac', maxCurrentA: 32 } }, CTX);
    const values = state.ops
      .find((o) => o.op === 'insert')
      ?.calls.find(([m]) => m === 'values')?.[1][0] as Record<string, unknown>;
    expect(values['phases']).toBe(1);
  });

  it('refuses a unit whose EVSEs mix AC and DC', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], [type2('evs_1'), ccs('evs_2')]];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'dc', maxPowerKw: 50 } },
      CTX,
    );
    expect(result).toEqual({ ok: false, reason: 'mixed_unit' });
    expect(state.ops.some((o) => o.op === 'insert')).toBe(false);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('refuses an EVSE holding both kinds as a mixed unit', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], [type2('evs_1'), ccs('evs_1')]];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'ac', maxCurrentA: 32, phases: 3 } },
      CTX,
    );
    expect(result).toEqual({ ok: false, reason: 'mixed_unit' });
  });

  it('refuses a budget of the other kind', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], [ccs('evs_1')]];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'ac', maxCurrentA: 32, phases: 3 } },
      CTX,
    );
    expect(result).toEqual({ ok: false, reason: 'kind_mismatch' });
  });

  it('answers a station of another site and a unit of another station', async () => {
    state.results = [[]];
    expect(
      await setUnitLoadBudget({ ...INPUT, budget: { kind: 'dc', maxPowerKw: 50 } }, CTX),
    ).toEqual({ ok: false, reason: 'station_not_found' });
    state.results = [[{ circuitId: null }], []];
    state.index = 0;
    expect(
      await setUnitLoadBudget({ ...INPUT, budget: { kind: 'dc', maxPowerKw: 50 } }, CTX),
    ).toEqual({ ok: false, reason: 'unit_not_found' });
  });

  it('asks for the phases of a station on no circuit', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], [type2('evs_1')]];
    await expect(
      setUnitLoadBudget({ ...INPUT, budget: { kind: 'ac', maxCurrentA: 32 } }, CTX),
    ).rejects.toBeInstanceOf(LoadTreeValidationError);
  });

  it('refuses an AC fuse whose 80 percent stays below 6 A', async () => {
    state.results = [[{ circuitId: 'cir_1' }], [{ name: 'Box 1' }], [type2('evs_1')]];
    const refused = setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'ac', maxCurrentA: 7.4, phases: 3 } },
      CTX,
    );
    await expect(refused).rejects.toBeInstanceOf(LoadTreeValidationError);
    await expect(refused).rejects.toMatchObject({ field: 'maxCurrentA' });
  });

  it('writes no audit row for the same budget', async () => {
    state.results = [
      [{ circuitId: null }],
      [{ name: 'Box 1' }],
      [type2('evs_1')],
      [acRow()],
      [acRow()],
    ];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'ac', maxCurrentA: 32, phases: 3 } },
      CTX,
    );
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('accepts a unit with no typed connector', async () => {
    state.results = [
      [{ circuitId: null }],
      [{ name: 'Box 1' }],
      [],
      [],
      [{ ...acRow(), kind: 'dc', maxCurrentA: null, phases: null, maxPowerKw: '50.00' }],
    ];
    const result = await setUnitLoadBudget(
      { ...INPUT, budget: { kind: 'dc', maxPowerKw: 50 } },
      CTX,
    );
    expect(result).toMatchObject({ ok: true, budget: { kind: 'dc', maxPowerKw: 50 } });
  });
});

describe('clearUnitLoadBudget', () => {
  it('removes the budget and audits it', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], [acRow()]];
    expect(await clearUnitLoadBudget(INPUT, CTX)).toEqual({ ok: true, removed: true });
    const audit = writeAuditMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(audit).toMatchObject({
      after: { unitBudget: null },
      notes: 'unit load budget removed: Box 1',
    });
  });

  it('writes no audit row when the unit had none', async () => {
    state.results = [[{ circuitId: null }], [{ name: 'Box 1' }], []];
    expect(await clearUnitLoadBudget(INPUT, CTX)).toEqual({ ok: true, removed: false });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
