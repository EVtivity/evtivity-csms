// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The paired simulator follows the operator's EVSE and connector edits:
// css_stations is keyed by the OCPP identity, and added, edited and deleted
// connectors reach css_evses.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Array<{ op: string; method: string; args: unknown[] }> = [];
  let selectResult: unknown[] = [];

  function chain(op: string, result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of [
      'from',
      'where',
      'values',
      'onConflictDoUpdate',
      'onConflictDoNothing',
      'returning',
    ]) {
      c[m] = vi.fn((...args: unknown[]) => {
        calls.push({ op, method: m, args });
        return c;
      });
    }
    c['then'] = (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown): unknown =>
      Promise.resolve(result).then(res, rej);
    return c;
  }

  const exec = {
    select: vi.fn(() => chain('select', selectResult)),
    insert: vi.fn((table: unknown) => {
      calls.push({ op: 'insert', method: 'into', args: [table] });
      return chain('insert', undefined);
    }),
    delete: vi.fn((table: unknown) => {
      calls.push({ op: 'delete', method: 'from', args: [table] });
      return chain('delete', undefined);
    }),
  };
  return {
    calls,
    exec,
    setSelect(r: unknown[]) {
      selectResult = r;
    },
  };
});

vi.mock('@evtivity/database', () => ({
  db: h.exec,
  cssStations: { id: 'css.id', stationId: 'css.station_id' },
  cssEvses: {
    cssStationId: 'css_evses.css_station_id',
    evseId: 'css_evses.evse_id',
    connectorId: 'css_evses.connector_id',
  },
  cssConfigVariables: {},
  evses: {},
  connectors: {},
  chargingStations: {},
  vendors: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  and: vi.fn((...conds: unknown[]) => ({ and: conds })),
}));

vi.mock('@evtivity/lib', () => ({
  mapConnectorTypeToCss: (t: string) => `css-${t}`,
  randomCssConnectorType: () => 'ac_type2',
  buildCssConfigDefaults: () => [],
}));

import { mirrorCssConnectors, removeCssConnectors } from '../lib/css-pairing.js';

type Exec = Parameters<typeof mirrorCssConnectors>[0];
const exec = h.exec as unknown as Exec;

function callsOf(op: string, method: string): unknown[][] {
  return h.calls.filter((c) => c.op === op && c.method === method).map((c) => c.args);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.setSelect([]);
});

describe('mirrorCssConnectors', () => {
  it('finds the paired simulator by the OCPP identity', async () => {
    h.setSelect([{ id: 'css_1' }]);
    await mirrorCssConnectors(exec, 'CS-1', [
      { evseId: 2, connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
    ]);
    expect(callsOf('select', 'where')[0]?.[0]).toEqual({ eq: ['css.station_id', 'CS-1'] });
    expect(callsOf('insert', 'values')[0]?.[0]).toEqual({
      cssStationId: 'css_1',
      evseId: 2,
      connectorId: 1,
      connectorType: 'css-CCS2',
      maxPowerW: 150000,
    });
    expect(callsOf('insert', 'onConflictDoUpdate')[0]?.[0]).toMatchObject({
      set: { connectorType: 'css-CCS2', maxPowerW: 150000 },
    });
  });

  it('keeps the simulator values the operator did not send', async () => {
    h.setSelect([{ id: 'css_1' }]);
    await mirrorCssConnectors(exec, 'CS-1', [{ evseId: 1, connectorId: 1, maxPowerKw: 22 }]);
    expect(callsOf('insert', 'onConflictDoUpdate')[0]?.[0]).toMatchObject({
      set: { maxPowerW: 22000 },
    });
    await mirrorCssConnectors(exec, 'CS-1', [{ evseId: 1, connectorId: 2 }]);
    expect(callsOf('insert', 'onConflictDoNothing')).toHaveLength(1);
  });

  it('does nothing for a station without a paired simulator', async () => {
    await mirrorCssConnectors(exec, 'CS-REAL', [{ evseId: 1, connectorId: 1 }]);
    expect(h.exec.insert).not.toHaveBeenCalled();
  });
});

describe('removeCssConnectors', () => {
  it('deletes a whole EVSE, or one connector, of the paired simulator', async () => {
    h.setSelect([{ id: 'css_1' }]);
    await removeCssConnectors(exec, 'CS-1', 2);
    await removeCssConnectors(exec, 'CS-1', 2, 1);
    const wheres = callsOf('delete', 'where').map((a) => a[0]);
    expect(wheres[0]).toEqual({
      and: [{ eq: ['css_evses.css_station_id', 'css_1'] }, { eq: ['css_evses.evse_id', 2] }],
    });
    expect(wheres[1]).toEqual({
      and: [
        { eq: ['css_evses.css_station_id', 'css_1'] },
        { eq: ['css_evses.evse_id', 2] },
        { eq: ['css_evses.connector_id', 1] },
      ],
    });
  });

  it('does nothing for a station without a paired simulator', async () => {
    await removeCssConnectors(exec, 'CS-REAL', 1);
    expect(h.exec.delete).not.toHaveBeenCalled();
  });
});
