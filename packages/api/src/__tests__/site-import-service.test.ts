// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  sites: {
    id: 'id',
    name: 'name',
    city: 'city',
    state: 'state',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
    siteId: 'siteId',
    model: 'model',
    serialNumber: 'serialNumber',
    vendorId: 'vendorId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  evses: { id: 'id', stationId: 'stationId', evseId: 'evseId' },
  connectors: {
    id: 'id',
    evseId: 'evseId',
    connectorId: 'connectorId',
    connectorType: 'connectorType',
    maxPowerKw: 'maxPowerKw',
  },
  vendors: { id: 'id', name: 'name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
}));

import {
  exportSitesCsv,
  exportSitesTemplateCsv,
  importSitesCsv,
} from '../services/site-import.service.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('exportSitesTemplateCsv', () => {
  it('returns CSV with header and template rows', () => {
    const csv = exportSitesTemplateCsv();
    const lines = csv.split('\n');

    expect(lines[0]).toBe(
      'siteName,stationId,stationModel,stationSerialNumber,stationStatus,onboardingStatus,evseId,connectorId,connectorType,maxPowerKw,maxCurrentAmps,stationVendor',
    );
    expect(lines.length).toBe(5); // header + 4 template rows
    expect(lines[1]).toContain('Downtown Garage');
    expect(lines[4]).toContain('Airport Lot');
  });
});

describe('exportSitesCsv', () => {
  it('returns CSV with header and data rows', async () => {
    const rows = [
      {
        siteName: 'Site A',
        stationId: 'CS-001',
        stationModel: 'Model X',
        stationSerialNumber: 'SN-111',
        stationStatus: 'available',
        onboardingStatus: 'accepted',
        evseId: 1,
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: 150,
        maxCurrentAmps: 200,
        vendorName: 'ACME',
      },
    ];
    setupDbResults(rows);

    const csv = await exportSitesCsv();
    const lines = csv.split('\n');

    expect(lines[0]).toBe(
      'siteName,stationId,stationModel,stationSerialNumber,stationStatus,onboardingStatus,evseId,connectorId,connectorType,maxPowerKw,maxCurrentAmps,stationVendor',
    );
    expect(lines[1]).toBe('Site A,CS-001,Model X,SN-111,available,accepted,1,1,CCS2,150,200,ACME');
  });

  it('applies search filter', async () => {
    setupDbResults([]);

    const csv = await exportSitesCsv('downtown');
    const lines = csv.split('\n');

    // Header only, no data
    expect(lines.length).toBe(1);
  });
});

describe('importSitesCsv', () => {
  it('validates missing siteName', async () => {
    const result = await importSitesCsv([{ siteName: '', stationId: 'CS-001' }], false);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('missing siteName');
  });

  it('validates invalid connectorType', async () => {
    const result = await importSitesCsv(
      [{ siteName: 'Site A', connectorType: 'InvalidType' }],
      false,
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('invalid connectorType');
    expect(result.errors[0]).toContain('InvalidType');
  });

  it('validates evseId without stationId', async () => {
    const result = await importSitesCsv([{ siteName: 'Site A', evseId: 1 }], false);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('evseId provided without stationId');
  });

  it('validates connectorId without evseId', async () => {
    const result = await importSitesCsv(
      [{ siteName: 'Site A', stationId: 'CS-001', connectorId: 1 }],
      false,
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('connectorId provided without evseId');
  });

  it('creates site when updateExisting is false and site does not exist', async () => {
    // Transaction flow for a new site with a station, EVSE, and connector:
    // 1. tx.select (site lookup) -> not found
    // 2. tx.insert (site create) -> returns site
    // 3. tx.select (station lookup) -> not found
    // 4. tx.insert (station create) -> returns station
    // 5. tx.select (EVSE lookup) -> not found
    // 6. tx.insert (EVSE create) -> returns EVSE
    // 7. tx.select (connector lookup) -> not found
    // 8. tx.insert (connector create) -> returns connector
    setupDbResults(
      [], // site lookup: not found
      [{ id: 'site-1' }], // site insert
      [], // station lookup: not found
      [{ id: 'station-1' }], // station insert
      [], // EVSE lookup: not found
      [{ id: 'evse-1' }], // EVSE insert
      [], // connector lookup: not found
      [], // connector insert
    );

    const result = await importSitesCsv(
      [
        {
          siteName: 'New Site',
          stationId: 'CS-001',
          stationModel: 'Model X',
          evseId: 1,
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: 150,
        },
      ],
      false,
    );

    expect(result.sitesCreated).toBe(1);
    expect(result.stationsCreated).toBe(1);
    expect(result.evsesCreated).toBe(1);
    expect(result.connectorsCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('skips existing site when updateExisting is false', async () => {
    // Transaction flow: site exists, station exists, EVSE exists, connector exists
    setupDbResults(
      [{ id: 'site-1' }], // site lookup: found
      [{ id: 'station-1' }], // station lookup: found
      [{ id: 'evse-1' }], // EVSE lookup: found
      [{ id: 'conn-1' }], // connector lookup: found
    );

    const result = await importSitesCsv(
      [
        {
          siteName: 'Existing Site',
          stationId: 'CS-001',
          evseId: 1,
          connectorId: 1,
          connectorType: 'CCS2',
        },
      ],
      false,
    );

    expect(result.sitesCreated).toBe(0);
    expect(result.errors.some((e) => e.includes('already exists'))).toBe(true);
  });

  it('upserts site when updateExisting is true', async () => {
    const now = new Date();
    // Transaction flow with updateExisting=true:
    // 1. tx.insert (site upsert) -> returns site with same createdAt/updatedAt (new)
    // 2. tx.insert (station upsert) -> returns station with same createdAt/updatedAt (new)
    // 3. tx.select (EVSE lookup) -> not found
    // 4. tx.insert (EVSE create) -> returns EVSE
    // 5. tx.select (connector lookup) -> not found
    // 6. tx.insert (connector create) -> returns connector
    setupDbResults(
      [{ id: 'site-1', createdAt: now, updatedAt: now }], // site upsert (created)
      [{ id: 'station-1', createdAt: now, updatedAt: now }], // station upsert (created)
      [], // EVSE lookup: not found
      [{ id: 'evse-1' }], // EVSE insert
      [], // connector lookup: not found
      [], // connector insert
    );

    const result = await importSitesCsv(
      [
        {
          siteName: 'Upsert Site',
          stationId: 'CS-001',
          evseId: 1,
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: 150,
        },
      ],
      true,
    );

    expect(result.sitesCreated).toBe(1);
    expect(result.stationsCreated).toBe(1);
    expect(result.evsesCreated).toBe(1);
    expect(result.connectorsCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
