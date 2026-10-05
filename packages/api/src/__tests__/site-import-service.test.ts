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

const { mockRecompute, mockSetDisabled, mockSendAvailability, mockPublishStatus } = vi.hoisted(
  () => ({
    mockRecompute: vi.fn().mockResolvedValue({ availabilityChanged: false }),
    mockSetDisabled: vi.fn().mockResolvedValue({ availabilityChanged: true }),
    mockSendAvailability: vi.fn().mockResolvedValue({}),
    mockPublishStatus: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@evtivity/services/availability-command', () => ({
  sendAvailabilityCommand: mockSendAvailability,
}));

vi.mock('../lib/station-status-events.js', () => ({
  publishStationStatusChanged: mockPublishStatus,
}));

const mockSiteMove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/ocpi-location-push.js', () => ({
  publishOcpiStationSiteMove: mockSiteMove,
}));

vi.mock('@evtivity/database', () => ({
  client: {},
  recomputeStationAvailability: mockRecompute,
  setStationDisabled: mockSetDisabled,
  stationAuditLog: { stationId: 'station_id' },
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
    availability: 'availability',
    disabledReason: 'disabledReason',
    isOnline: 'isOnline',
    onboardingStatus: 'onboardingStatus',
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
    maxCurrentAmps: 'maxCurrentAmps',
  },
  vendors: { id: 'id', name: 'name' },
  siteAuditLog: { siteId: 'site_id' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  sql: (...args: unknown[]) => ({ __brand: 'SQL', args }),
}));

import {
  exportSitesCsv,
  exportSitesTemplateCsv,
  importSitesCsv,
} from '../services/site-import.service.js';
import { writeAudit } from '@evtivity/database';

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

  it('exports the operator choice as stationStatus, not the computed availability', async () => {
    const { db } = await import('@evtivity/database');
    setupDbResults([]);

    await exportSitesCsv();

    const selection = vi.mocked(db.select).mock.calls[0]?.[0] as unknown as Record<
      string,
      { args: unknown[] }
    >;
    const strings = (selection['stationStatus']?.args[0] as string[]).join('?');
    expect(strings).toContain("= 'operator' THEN 'unavailable'");
    expect(strings).toContain("ELSE 'available'");
    expect(selection['stationStatus']?.args).toContain('disabledReason');
  });

  it('applies search filter', async () => {
    setupDbResults([]);

    const csv = await exportSitesCsv('downtown');
    const lines = csv.split('\n');

    // Header only, no data
    expect(lines.length).toBe(1);
  });

  it('returns only the header when siteIds is an empty array', async () => {
    const csv = await exportSitesCsv(undefined, []);
    expect(csv.split('\n')).toHaveLength(1);
  });

  it('applies the siteIds filter and renders empty join columns', async () => {
    setupDbResults([
      {
        siteName: 'Scoped Site',
        stationId: null,
        stationModel: null,
        stationSerialNumber: null,
        stationStatus: null,
        onboardingStatus: null,
        evseId: null,
        connectorId: null,
        connectorType: null,
        maxPowerKw: null,
        maxCurrentAmps: null,
        vendorName: null,
      },
    ]);

    const csv = await exportSitesCsv('term', ['sit_1']);
    const lines = csv.split('\n');

    expect(lines[1]).toBe('Scoped Site,,,,,,,,,,,');
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
    // Transaction flow with updateExisting=true (post case-insensitive fix):
    // 1. tx.select (ilike duplicate-name pre-check) -> not found, so site is new
    // 2. tx.insert (site insert) -> returns new site
    // 3. tx.select (the station's previous site) -> not found
    // 4. tx.insert (station upsert) -> returns station
    // 4. tx.select (EVSE lookup) -> not found
    // 5. tx.insert (EVSE create) -> returns EVSE
    // 6. tx.select (connector lookup) -> not found
    // 7. tx.insert (connector create) -> returns connector
    setupDbResults(
      [], // ilike duplicate check: not found
      [{ id: 'site-1', createdAt: now, updatedAt: now }], // site insert (created)
      [], // the station's previous site: none (new station)
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

  it('skips null rows in the input array', async () => {
    // A site-only row plus a hole; the hole is skipped, the site is created.
    setupDbResults([], [{ id: 'site-1' }]);

    const result = await importSitesCsv([null as never, { siteName: 'Only Site' }], false);

    expect(result.sitesCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('writes a created audit row when an actor is provided and a new site is inserted', async () => {
    setupDbResults([], [{ id: 'site-1', name: 'Audited Site' }]);

    const result = await importSitesCsv([{ siteName: 'Audited Site' }], false, {
      actor: 'operator',
      actorUserId: 'usr_1',
    });

    expect(result.sitesCreated).toBe(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'site_id' }),
      expect.objectContaining({ action: 'created', notes: 'CSV import' }),
      expect.anything(),
    );
  });

  it('updates an existing site and writes an updated audit row when updateExisting and actor given', async () => {
    const existing = { id: 'site-1', name: 'Existing' };
    // 1. site lookup -> found
    // 2. site update returning -> updated row
    setupDbResults([existing], [{ id: 'site-1', name: 'Existing', updatedAt: new Date() }]);

    const result = await importSitesCsv([{ siteName: 'Existing' }], true, {
      actor: 'operator',
      actorUserId: 'usr_1',
    });

    expect(result.sitesUpdated).toBe(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'site_id' }),
      expect.objectContaining({ action: 'updated', notes: 'CSV import' }),
      expect.anything(),
    );
  });

  it('rejects new-site creation for a restricted operator', async () => {
    setupDbResults([]); // site lookup: not found

    const result = await importSitesCsv([{ siteName: 'Blocked Site' }], false, undefined, [
      'sit_allowed',
    ]);

    expect(result.sitesCreated).toBe(0);
    expect(result.errors[0]).toContain('insufficient site access to create new site');
  });

  it('rejects mutating a site outside the restricted operator allow-list', async () => {
    setupDbResults([{ id: 'sit_other', name: 'Other Site' }]);

    const result = await importSitesCsv([{ siteName: 'Other Site' }], true, undefined, [
      'sit_allowed',
    ]);

    expect(result.sitesUpdated).toBe(0);
    expect(result.errors[0]).toContain('no access to site');
  });

  it('resolves a vendor by case-insensitive name and reuses the cache across stations', async () => {
    const now = new Date();
    // 1. site lookup -> not found
    // 2. site insert -> site-1
    // 3. vendor lookup -> found
    // 4. station insert (CS-001) -> station-1
    // 5. site lookup again? no. Two stations share the vendor name; second uses cache.
    // 4. station CS-001 insert (updateExisting false path uses select-then-insert)
    setupDbResults(
      [], // site lookup
      [{ id: 'site-1' }], // site insert
      [{ id: 'vnd_1' }], // vendor lookup -> found
      [], // station CS-001 lookup: not found
      [{ id: 'station-1' }], // station CS-001 insert
      [], // station CS-002 lookup: not found (vendor from cache, no lookup)
      [{ id: 'station-2' }], // station CS-002 insert
    );

    const result = await importSitesCsv(
      [
        { siteName: 'Vendor Site', stationId: 'CS-001', stationVendor: 'acme chargers' },
        { siteName: 'Vendor Site', stationId: 'CS-002', stationVendor: 'acme chargers' },
      ],
      false,
    );

    expect(result.stationsCreated).toBe(2);
    expect(result.errors).toEqual([]);
    void now;
  });

  it('records an error when a referenced vendor is not found', async () => {
    setupDbResults(
      [], // site lookup
      [{ id: 'site-1' }], // site insert
      [], // vendor lookup -> empty
      [], // station lookup: not found
      [{ id: 'station-1' }], // station insert
    );

    const result = await importSitesCsv(
      [{ siteName: 'Site', stationId: 'CS-001', stationVendor: 'Ghost Vendor' }],
      false,
    );

    expect(result.errors.some((e) => e.includes('vendor "Ghost Vendor" not found'))).toBe(true);
  });

  it('pushes the OCPI locations of a station the import moves to another site', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const updated = new Date('2026-02-01T00:00:00Z');
    setupDbResults(
      [], // site ilike pre-check: not found
      [{ id: 'site-1', createdAt: created, updatedAt: created }], // site insert (created)
      [{ siteId: 'site-0' }], // the station's previous site
      [{ id: 'station-1', createdAt: created, updatedAt: updated }], // station upsert -> UPDATED
    );

    await importSitesCsv([{ siteName: 'Moved', stationId: 'CS-001' }], true);

    expect(mockSiteMove).toHaveBeenCalledWith('station-1', 'site-0', 'site-1', undefined);
  });

  it('counts a station as updated when the upsert returns differing timestamps', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const updated = new Date('2026-02-01T00:00:00Z');
    setupDbResults(
      [], // site ilike pre-check: not found
      [{ id: 'site-1', createdAt: created, updatedAt: created }], // site insert (created)
      [], // the station's previous site: none (new station)
      [{ id: 'station-1', createdAt: created, updatedAt: updated }], // station upsert -> UPDATED
    );

    const result = await importSitesCsv(
      [{ siteName: 'Upsert', stationId: 'CS-001', stationModel: 'M', stationStatus: 'available' }],
      true,
    );

    expect(result.stationsUpdated).toBe(1);
    expect(result.stationsCreated).toBe(0);
  });

  function stationImportResults(current: Record<string, unknown>): unknown[][] {
    const now = new Date();
    return [
      [], // site ilike pre-check: not found
      [{ id: 'site-1', createdAt: now, updatedAt: now }], // site insert
      [], // the station's previous site: none (new station)
      [{ id: 'station-1', createdAt: now, updatedAt: now }], // station upsert (created)
      [
        {
          id: 'station-1',
          stationId: 'CS-001',
          siteId: 'site-1',
          isOnline: true,
          disabledReason: null,
          ...current,
        },
      ], // stored state after the import commits
    ];
  }

  it('recomputes availability when stationStatus does not change the disable', async () => {
    mockRecompute.mockResolvedValueOnce({ availabilityChanged: true });
    setupDbResults(...stationImportResults({}));

    await importSitesCsv(
      [{ siteName: 'On', stationId: 'CS-001', stationStatus: 'available' }],
      true,
    );

    expect(mockRecompute).toHaveBeenCalledWith({}, 'station-1');
    expect(mockSetDisabled).not.toHaveBeenCalled();
    expect(mockSendAvailability).not.toHaveBeenCalled();
    expect(mockPublishStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'station-1', siteId: 'site-1' }),
      undefined,
    );
  });

  it('disables through the status entry point, tells the station, audits, and publishes', async () => {
    setupDbResults(...stationImportResults({}));

    await importSitesCsv(
      [{ siteName: 'Off', stationId: 'CS-001', stationStatus: 'unavailable' }],
      true,
      { actor: 'operator', actorUserId: 'usr_1' },
    );

    expect(mockSetDisabled).toHaveBeenCalledWith({}, 'station-1', 'operator');
    expect(mockSendAvailability).toHaveBeenCalledWith('CS-001', 'Inoperative', undefined);
    expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'availability_changed',
        before: { disabledReason: null },
        after: { disabledReason: 'operator' },
      }),
      expect.anything(),
      undefined,
    );
    expect(mockPublishStatus).toHaveBeenCalled();
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('enables an operator-disabled station and skips the command when offline', async () => {
    setupDbResults(...stationImportResults({ disabledReason: 'operator', isOnline: false }));

    await importSitesCsv([{ siteName: 'On', stationId: 'CS-001', stationStatus: 'faulted' }], true);

    expect(mockSetDisabled).toHaveBeenCalledWith({}, 'station-1', null);
    expect(mockSendAvailability).not.toHaveBeenCalled();
    expect(mockPublishStatus).toHaveBeenCalled();
  });

  it('never clears or replaces a security disable', async () => {
    for (const stationStatus of ['available', 'unavailable'] as const) {
      mockSetDisabled.mockClear();
      setupDbResults(...stationImportResults({ disabledReason: 'security' }));

      await importSitesCsv([{ siteName: 'Sec', stationId: 'CS-001', stationStatus }], true);

      expect(mockSetDisabled).not.toHaveBeenCalled();
      expect(mockSendAvailability).not.toHaveBeenCalled();
    }
  });

  it('leaves the disable alone when stationStatus is omitted', async () => {
    setupDbResults(...stationImportResults({ disabledReason: 'operator' }));

    await importSitesCsv([{ siteName: 'Keep', stationId: 'CS-001' }], true);

    expect(mockSetDisabled).not.toHaveBeenCalled();
    expect(mockRecompute).toHaveBeenCalledWith({}, 'station-1');
  });

  it('updates an existing EVSE and connector with maxCurrentAmps when updateExisting is true', async () => {
    const now = new Date();
    setupDbResults(
      [], // site ilike pre-check: not found
      [{ id: 'site-1', createdAt: now, updatedAt: now }], // site insert
      [], // the station's previous site: none (new station)
      [{ id: 'station-1', createdAt: now, updatedAt: now }], // station upsert (created)
      [{ id: 'evse-1' }], // EVSE lookup -> found
      [], // EVSE update (no returning needed)
      [{ id: 'conn-1' }], // connector lookup -> found
      [], // connector update
    );

    const result = await importSitesCsv(
      [
        {
          siteName: 'Site',
          stationId: 'CS-001',
          evseId: 1,
          connectorId: 1,
          connectorType: 'Type2',
          maxPowerKw: 22,
          maxCurrentAmps: 32,
        },
      ],
      true,
    );

    expect(result.evsesUpdated).toBe(1);
    expect(result.connectorsUpdated).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
