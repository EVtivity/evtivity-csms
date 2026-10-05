// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface InsertRecord {
  table: string;
  values: unknown;
}
interface UpdateRecord {
  table: string;
  set: Record<string, unknown>;
}

const h = vi.hoisted(() => {
  const state = {
    selectResults: [] as unknown[][],
    selectIdx: 0,
    insertRecords: [] as InsertRecord[],
    updateRecords: [] as UpdateRecord[],
    forceEmptyReturning: false,
  };

  function tableName(table: unknown): string {
    if (typeof table === 'object' && table != null && 'tableName' in table) {
      return (table as { tableName: string }).tableName;
    }
    return 'unknown';
  }

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'limit', 'orderBy']) {
      chain[m] = vi.fn(() => chain);
    }
    let awaited = false;
    chain['then'] = (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown): unknown => {
      if (!awaited) {
        awaited = true;
        const r = state.selectResults[state.selectIdx] ?? [];
        state.selectIdx++;
        return Promise.resolve(r).then(res, rej);
      }
      return Promise.resolve([]).then(res, rej);
    };
    return chain;
  }

  function makeInsertChain(table: unknown): Record<string, unknown> {
    const empty = state.forceEmptyReturning && tableName(table) === 'cssStations';
    state.forceEmptyReturning = false;
    const chain: Record<string, unknown> = {};
    chain['values'] = vi.fn((values: unknown) => {
      state.insertRecords.push({ table: tableName(table), values });
      return chain;
    });
    chain['returning'] = vi.fn(() => Promise.resolve(empty ? [] : [{ id: 'css_1' }]));
    let awaited = false;
    chain['then'] = (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown): unknown => {
      if (!awaited) {
        awaited = true;
        return Promise.resolve(undefined).then(res, rej);
      }
      return Promise.resolve(undefined).then(res, rej);
    };
    return chain;
  }

  function makeUpdateChain(table: unknown): Record<string, unknown> {
    const setObj: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        Object.assign(setObj, v);
        state.updateRecords.push({ table: tableName(table), set: setObj });
        return chain;
      }),
      where: vi.fn(() => Promise.resolve(undefined)),
    };
    return chain;
  }

  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn((table: unknown) => makeInsertChain(table)),
    update: vi.fn((table: unknown) => makeUpdateChain(table)),
  };
  dbMock['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbMock));

  return {
    state,
    tableName,
    dbMock,
    mapConnectorTypeToCssMock: vi.fn((t: string) => `css-${t}`),
    randomCssConnectorTypeMock: vi.fn(() => 'ccs2'),
    buildCssConfigDefaultsMock: vi.fn(() => [
      { key: 'ChargingStation.VendorName', value: 'EVtivity', readonly: true },
    ]),
  };
});

vi.mock('@evtivity/database', () => ({
  db: h.dbMock,
  cssStations: { id: 'id', stationId: 'stationId', tableName: 'cssStations' },
  cssEvses: { tableName: 'cssEvses' },
  cssConfigVariables: { tableName: 'cssConfigVariables' },
  evses: { id: 'id', stationId: 'evses.stationId', evseId: 'evseId', tableName: 'evses' },
  connectors: { evseId: 'evseId', tableName: 'connectors' },
  chargingStations: { id: 'cs.id', stationId: 'cs.stationId', tableName: 'chargingStations' },
  vendors: { id: 'id', name: 'name', tableName: 'vendors' },
}));

const eqMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({})));
vi.mock('drizzle-orm', () => ({
  eq: eqMock,
}));

vi.mock('@evtivity/lib', () => ({
  mapConnectorTypeToCss: h.mapConnectorTypeToCssMock,
  randomCssConnectorType: h.randomCssConnectorTypeMock,
  buildCssConfigDefaults: h.buildCssConfigDefaultsMock,
}));

import { enableCssPair, disableCssPair } from '../lib/css-pairing.js';

const baseOpts = {
  stationId: 'CS-1',
  ocppProtocol: 'ocpp2.1' as const,
  securityProfile: 1,
  serverUrl: 'ws://server',
  tlsServerUrl: 'wss://server',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selectResults = [];
  h.state.selectIdx = 0;
  h.state.insertRecords.length = 0;
  h.state.updateRecords.length = 0;
  h.state.forceEmptyReturning = false;
});

function findInsert(table: string): InsertRecord | undefined {
  return h.state.insertRecords.find((r) => r.table === table);
}

describe('enableCssPair', () => {
  it('re-enables an existing css_stations row without inserting', async () => {
    h.state.selectResults = [[{ id: 'css_existing' }]];
    await enableCssPair(baseOpts);

    expect(h.state.updateRecords[0]?.table).toBe('cssStations');
    expect(h.state.updateRecords[0]?.set['enabled']).toBe(true);
    expect(h.state.insertRecords.length).toBe(0);
  });

  it('creates css_stations, mirrors existing EVSEs, and seeds config defaults', async () => {
    h.state.selectResults = [
      [], // existing css lookup: none
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: 'vnd_1' }], // parent
      [{ name: 'Acme' }], // vendor
      [{ evseId: 1, connectorId: 1, connectorType: 'CCS2', maxPowerKw: '50' }], // existing evses
    ];

    await enableCssPair(baseOpts);

    expect(h.dbMock['transaction']).toHaveBeenCalled();

    const cssInsert = findInsert('cssStations');
    expect(cssInsert?.values).toMatchObject({
      stationId: 'CS-1',
      targetUrl: 'ws://server',
      sourceType: 'api',
      enabled: true,
    });

    const evseInsert = findInsert('cssEvses');
    expect(evseInsert?.values).toEqual([
      expect.objectContaining({
        cssStationId: 'css_1',
        evseId: 1,
        connectorId: 1,
        connectorType: 'css-CCS2',
        maxPowerW: 50000,
      }),
    ]);
    expect(h.mapConnectorTypeToCssMock).toHaveBeenCalledWith('CCS2');

    expect(h.buildCssConfigDefaultsMock).toHaveBeenCalledWith(
      expect.objectContaining({ vendorName: 'Acme', model: 'M1', targetUrl: 'ws://server' }),
    );
    expect(findInsert('cssConfigVariables')).toBeDefined();
  });

  it('looks the parent station up by its OCPP identity and its EVSEs by its id', async () => {
    h.state.selectResults = [
      [],
      [
        {
          id: 'sta_parent',
          model: 'M1',
          serialNumber: 'SN1',
          firmwareVersion: '2.0',
          vendorId: null,
        },
      ],
      [{ evseId: 1, connectorId: 1, connectorType: 'CCS2', maxPowerKw: '50' }],
    ];

    await enableCssPair(baseOpts);

    expect(eqMock).toHaveBeenCalledWith('cs.stationId', 'CS-1');
    expect(eqMock).toHaveBeenCalledWith('evses.stationId', 'sta_parent');
    expect(eqMock).not.toHaveBeenCalledWith('cs.id', 'CS-1');
  });

  it('picks the TLS url when securityProfile >= 2 and vendorId is null', async () => {
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
      [{ evseId: 1, connectorId: 1, connectorType: 'CCS2', maxPowerKw: '50' }],
    ];

    await enableCssPair({ ...baseOpts, securityProfile: 2 });

    expect(findInsert('cssStations')?.values).toMatchObject({ targetUrl: 'wss://server' });
    expect(h.buildCssConfigDefaultsMock).toHaveBeenCalledWith(
      expect.objectContaining({ vendorName: 'EVtivity' }),
    );
  });

  it('uses default power (22000) when the mirrored connector has no maxPowerKw', async () => {
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
      [{ evseId: 2, connectorId: 1, connectorType: 'Type2', maxPowerKw: null }],
    ];

    await enableCssPair(baseOpts);

    expect(findInsert('cssEvses')?.values).toEqual([
      expect.objectContaining({ evseId: 2, maxPowerW: 22000 }),
    ]);
  });

  it('creates a single default EVSE with a random plug type when the parent has none', async () => {
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
      [],
    ];

    await enableCssPair(baseOpts);

    expect(h.randomCssConnectorTypeMock).toHaveBeenCalled();
    expect(findInsert('cssEvses')?.values).toEqual([
      expect.objectContaining({
        evseId: 1,
        connectorId: 1,
        connectorType: 'ccs2',
        maxPowerW: 22000,
      }),
    ]);
  });

  it('falls back to default device metadata when the parent station is missing', async () => {
    h.state.selectResults = [[], [], []];

    await enableCssPair(baseOpts);

    expect(h.buildCssConfigDefaultsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorName: 'EVtivity',
        model: 'CSS-1000',
        serialNumber: 'SN-CS-1',
        firmwareVersion: '1.0.0',
      }),
    );
  });

  it('ignores a blank vendor name and keeps the EVtivity default', async () => {
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: 'vnd_1' }],
      [{ name: '' }],
      [],
    ];

    await enableCssPair(baseOpts);

    expect(h.buildCssConfigDefaultsMock).toHaveBeenCalledWith(
      expect.objectContaining({ vendorName: 'EVtivity' }),
    );
  });

  it('skips the config-variable insert when no defaults are produced', async () => {
    h.buildCssConfigDefaultsMock.mockReturnValueOnce([]);
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
      [],
    ];

    await enableCssPair(baseOpts);

    expect(findInsert('cssConfigVariables')).toBeUndefined();
  });

  it('reuses a provided transaction instead of opening a new one', async () => {
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
      [],
    ];

    // Pass the same dbMock as the tx; the helper must NOT open a nested
    // db.transaction when an executor is supplied.
    await enableCssPair(baseOpts, h.dbMock as never);

    expect(h.dbMock['transaction']).not.toHaveBeenCalled();
    expect(findInsert('cssStations')).toBeDefined();
  });

  it('returns early when the css_stations insert returns no row', async () => {
    h.state.forceEmptyReturning = true;
    h.state.selectResults = [
      [],
      [{ model: 'M1', serialNumber: 'SN1', firmwareVersion: '2.0', vendorId: null }],
    ];

    await enableCssPair(baseOpts);

    expect(findInsert('cssEvses')).toBeUndefined();
    expect(findInsert('cssConfigVariables')).toBeUndefined();
  });
});

describe('disableCssPair', () => {
  it('sets enabled=false on the css_stations row', async () => {
    await disableCssPair('CS-1');
    expect(h.state.updateRecords[0]?.table).toBe('cssStations');
    expect(h.state.updateRecords[0]?.set['enabled']).toBe(false);
  });

  it('uses the default db when no executor is passed', async () => {
    await disableCssPair('CS-2');
    expect(h.dbMock['update']).toHaveBeenCalled();
  });

  it('uses a provided transaction executor when supplied', async () => {
    const txUpdate: UpdateRecord[] = [];
    const tx = {
      update: vi.fn((table: unknown) => {
        const setObj: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          set: vi.fn((v: Record<string, unknown>) => {
            Object.assign(setObj, v);
            txUpdate.push({ table: h.tableName(table), set: setObj });
            return chain;
          }),
          where: vi.fn(() => Promise.resolve(undefined)),
        };
        return chain;
      }),
    };

    await disableCssPair('CS-1', tx as never);

    expect(txUpdate[0]?.set['enabled']).toBe(false);
  });
});
