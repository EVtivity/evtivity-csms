// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sequential result queue for DB mock
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
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
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
  fleets: {},
  fleetDrivers: {},
  fleetStations: {},
  drivers: {},
  vehicles: {},
  chargingStations: {},
  chargingSessions: {},
  sites: {},
  pricingGroupFleets: {},
  pricingGroups: { id: 'id', name: 'name', isDefault: 'isDefault' },
  driverTokens: {},
  users: {},
  evses: {},
  connectors: {},
  transactionEvents: {},
  tariffs: {
    id: 'id',
    pricingGroupId: 'pricingGroupId',
    isActive: 'isActive',
    priority: 'priority',
    isDefault: 'isDefault',
    restrictions: 'restrictions',
    name: 'name',
    currency: 'currency',
    pricePerKwh: 'pricePerKwh',
    pricePerMinute: 'pricePerMinute',
    pricePerSession: 'pricePerSession',
    idleFeePricePerMinute: 'idleFeePricePerMinute',
    taxRate: 'taxRate',
  },
  pricingGroupStations: {},
  pricingGroupDrivers: {},
  pricingGroupSites: {},
  pricingHolidays: { date: 'date' },
  settings: {},
  sitePaymentConfigs: {},
  meterValues: {},
  siteLoadManagement: {},
  loadAllocationLog: {},
  guestSessions: {},
  vendors: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  desc: vi.fn(),
  asc: vi.fn(),
  gte: vi.fn(),
  count: vi.fn(),
}));

import {
  listDrivers,
  getDriver,
  createDriver,
  updateDriver,
  getDriverTokens,
  createDriverToken,
  deactivateDriverToken,
} from '../services/driver.service.js';

import {
  listStations,
  getStation,
  createStation,
  updateStation,
  removeStation,
  getStationEvses,
  getEvseConnectors,
} from '../services/station.service.js';

import { listSessions, getSession } from '../services/session.service.js';

import {
  listTransactionEvents,
  getTransactionEventsBySession,
  getSessionByTransactionId,
} from '../services/transaction.service.js';

import {
  listPricingGroups,
  createPricingGroup,
  getGroupTariffs,
  createTariff,
} from '../services/pricing.service.js';

import { resolveTariff } from '../services/tariff.service.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Driver Service
// ---------------------------------------------------------------------------
describe('Driver Service', () => {
  describe('listDrivers', () => {
    it('returns all drivers ordered by createdAt', async () => {
      const rows = [
        { id: 'd1', firstName: 'Alice' },
        { id: 'd2', firstName: 'Bob' },
      ];
      setupDbResults(rows);

      const result = await listDrivers();

      expect(result).toEqual(rows);
    });
  });

  describe('getDriver', () => {
    it('returns driver when found', async () => {
      const driver = { id: 'd1', firstName: 'Alice' };
      setupDbResults([driver]);

      const result = await getDriver('d1');

      expect(result).toEqual(driver);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await getDriver('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createDriver', () => {
    it('creates and returns driver', async () => {
      const driver = { id: 'd1', firstName: 'Alice', lastName: 'Smith' };
      setupDbResults([driver]);

      const result = await createDriver({ firstName: 'Alice', lastName: 'Smith' });

      expect(result).toEqual(driver);
    });
  });

  describe('updateDriver', () => {
    it('returns updated driver when found', async () => {
      const driver = { id: 'd1', firstName: 'Alice Updated' };
      setupDbResults([driver]);

      const result = await updateDriver('d1', { firstName: 'Alice Updated' });

      expect(result).toEqual(driver);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await updateDriver('nonexistent', { firstName: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('getDriverTokens', () => {
    it('returns tokens for driver', async () => {
      const tokens = [{ id: 't1', idToken: 'ABC', tokenType: 'ISO14443' }];
      setupDbResults(tokens);

      const result = await getDriverTokens('d1');

      expect(result).toEqual(tokens);
    });
  });

  describe('createDriverToken', () => {
    it('creates and returns token', async () => {
      const token = { id: 't1', driverId: 'd1', idToken: 'ABC', tokenType: 'ISO14443' };
      setupDbResults([token]);

      const result = await createDriverToken('d1', { idToken: 'ABC', tokenType: 'ISO14443' });

      expect(result).toEqual(token);
    });
  });

  describe('deactivateDriverToken', () => {
    it('returns deactivated token when found', async () => {
      const token = { id: 't1', isActive: false };
      setupDbResults([token]);

      const result = await deactivateDriverToken('t1');

      expect(result).toEqual(token);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await deactivateDriverToken('nonexistent');

      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Station Service
// ---------------------------------------------------------------------------
describe('Station Service', () => {
  describe('listStations', () => {
    it('returns all stations', async () => {
      const rows = [{ id: 's1', stationId: 'CS001' }];
      setupDbResults(rows);

      const result = await listStations();

      expect(result).toEqual(rows);
    });
  });

  describe('getStation', () => {
    it('returns station when found', async () => {
      const station = { id: 's1', stationId: 'CS001' };
      setupDbResults([station]);

      const result = await getStation('s1');

      expect(result).toEqual(station);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await getStation('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createStation', () => {
    it('creates and returns station', async () => {
      const station = { id: 's1', stationId: 'CS002', model: 'Model X' };
      setupDbResults([station]);

      const result = await createStation({ stationId: 'CS002', model: 'Model X' });

      expect(result).toEqual(station);
    });
  });

  describe('updateStation', () => {
    it('returns updated station when found', async () => {
      const station = { id: 's1', model: 'Updated Model' };
      setupDbResults([station]);

      const result = await updateStation('s1', { model: 'Updated Model' });

      expect(result).toEqual(station);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await updateStation('nonexistent', { model: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('removeStation', () => {
    it('returns removed station when found', async () => {
      const station = { id: 's1', availability: 'removed' };
      setupDbResults([station]);

      const result = await removeStation('s1');

      expect(result).toEqual(station);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await removeStation('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getStationEvses', () => {
    it('returns EVSEs for station', async () => {
      const evses = [{ id: 'e1', stationId: 's1', evseId: 1 }];
      setupDbResults(evses);

      const result = await getStationEvses('s1');

      expect(result).toEqual(evses);
    });
  });

  describe('getEvseConnectors', () => {
    it('returns connectors for EVSE', async () => {
      const connectors = [{ id: 'c1', evseId: 'e1', connectorType: 'CCS2' }];
      setupDbResults(connectors);

      const result = await getEvseConnectors('e1');

      expect(result).toEqual(connectors);
    });
  });
});

// ---------------------------------------------------------------------------
// Session Service
// ---------------------------------------------------------------------------
describe('Session Service', () => {
  describe('listSessions', () => {
    it('returns sessions with default limit', async () => {
      const rows = [{ id: 'sess1', status: 'completed' }];
      setupDbResults(rows);

      const result = await listSessions();

      expect(result).toEqual(rows);
    });

    it('returns sessions with custom limit', async () => {
      const rows = [{ id: 'sess1' }, { id: 'sess2' }];
      setupDbResults(rows);

      const result = await listSessions(50);

      expect(result).toEqual(rows);
    });
  });

  describe('getSession', () => {
    it('returns session when found', async () => {
      const session = { id: 'sess1', status: 'completed' };
      setupDbResults([session]);

      const result = await getSession('sess1');

      expect(result).toEqual(session);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await getSession('nonexistent');

      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Transaction Service
// ---------------------------------------------------------------------------
describe('Transaction Service', () => {
  describe('listTransactionEvents', () => {
    it('returns paginated data and total', async () => {
      const event = { id: 'te1', triggerReason: 'Authorized' };
      setupDbResults([{ event }], [{ count: 1 }]);

      const result = await listTransactionEvents({ page: 1, limit: 10 });

      expect(result.data).toEqual([event]);
      expect(result.total).toBe(1);
    });

    it('returns total 0 when count row is empty', async () => {
      setupDbResults([], []);

      const result = await listTransactionEvents({ page: 1, limit: 10, search: 'nothing' });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('getTransactionEventsBySession', () => {
    it('returns events for a session', async () => {
      const events = [{ id: 'te1', sessionId: 'sess1', seqNo: 1 }];
      setupDbResults(events);

      const result = await getTransactionEventsBySession('sess1');

      expect(result).toEqual(events);
    });
  });

  describe('getSessionByTransactionId', () => {
    it('returns session when found', async () => {
      const session = { id: 'sess1', transactionId: 'tx1' };
      setupDbResults([session]);

      const result = await getSessionByTransactionId('tx1');

      expect(result).toEqual(session);
    });

    it('returns null when not found', async () => {
      setupDbResults([]);

      const result = await getSessionByTransactionId('nonexistent');

      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Pricing Service
// ---------------------------------------------------------------------------
describe('Pricing Service', () => {
  describe('listPricingGroups', () => {
    it('returns all pricing groups', async () => {
      const groups = [{ id: 'pg1', name: 'Standard' }];
      setupDbResults(groups);

      const result = await listPricingGroups();

      expect(result).toEqual(groups);
    });
  });

  describe('createPricingGroup', () => {
    it('creates and returns pricing group', async () => {
      const group = { id: 'pg1', name: 'Premium', description: 'For premium users' };
      setupDbResults([group]);

      const result = await createPricingGroup({
        name: 'Premium',
        description: 'For premium users',
      });

      expect(result).toEqual(group);
    });
  });

  describe('getGroupTariffs', () => {
    it('returns tariffs for a pricing group', async () => {
      const tariffs = [{ id: 't1', name: 'Peak', pricePerKwh: '0.30' }];
      setupDbResults(tariffs);

      const result = await getGroupTariffs('pg1');

      expect(result).toEqual(tariffs);
    });
  });

  describe('createTariff', () => {
    it('creates and returns tariff', async () => {
      const tariff = { id: 't1', pricingGroupId: 'pg1', name: 'Off-Peak', pricePerKwh: '0.15' };
      setupDbResults([tariff]);

      const result = await createTariff('pg1', { name: 'Off-Peak', pricePerKwh: '0.15' });

      expect(result).toEqual(tariff);
    });
  });
});

// ---------------------------------------------------------------------------
// Tariff Service (resolveTariff)
// ---------------------------------------------------------------------------
describe('Tariff Service', () => {
  const mockGroup = { groupId: 'pgr_000000000001', groupName: 'Test Group' };
  const mockTariffRow = {
    id: 't1',
    name: 'Test Tariff',
    currency: 'USD',
    pricePerKwh: '0.25',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    taxRate: null,
    restrictions: null,
    priority: 0,
    isDefault: true,
  };

  // resolveTariff does:
  // 1. resolveTariffGroup(): queries up to 5 priority levels (driver, fleet, station, site, default)
  //    Driver and fleet groups apply at all stations (no station join).
  //    Station and site groups require station assignment.
  // 2. Fetches ALL active tariffs in the resolved group (1 query)
  // 3. Loads holidays (1 query)
  // 4. Calls resolveActiveTariff() from @evtivity/lib to pick the matching tariff

  describe('resolveTariff', () => {
    it('returns driver-specific tariff when found (priority 1)', async () => {
      // Q1: driver group query (no station join) -> found
      // Q2: active tariffs fetch
      // Q3: holidays load
      setupDbResults([mockGroup], [mockTariffRow], []);

      const result = await resolveTariff('sta_000000000001', 'drv_000000000001');

      expect(result).toEqual(mockTariffRow);
    });

    it('returns fleet tariff when driver query returns empty (priority 2)', async () => {
      // Q1: driver group -> empty
      // Q2: fleet group (no station join) -> found
      // Q3: active tariffs fetch
      // Q4: holidays load
      setupDbResults([], [mockGroup], [mockTariffRow], []);

      const result = await resolveTariff('sta_000000000001', 'drv_000000000001');

      expect(result).toEqual(mockTariffRow);
    });

    it('returns station tariff when driver and fleet return empty (priority 3)', async () => {
      // Q1: driver group -> empty, Q2: fleet group -> empty, Q3: station group -> found
      // Q4: active tariffs fetch, Q5: holidays load
      setupDbResults([], [], [mockGroup], [mockTariffRow], []);

      const result = await resolveTariff('sta_000000000001', 'drv_000000000001');

      expect(result).toEqual(mockTariffRow);
    });

    it('returns null when no tariff matches any priority', async () => {
      // All 5 group queries return empty (driver, fleet, station, site, default)
      setupDbResults([], [], [], [], []);

      const result = await resolveTariff('sta_000000000001', 'drv_000000000001');

      expect(result).toBeNull();
    });

    it('skips driver and fleet queries when driverId is null', async () => {
      // With null driverId: Q1: station -> empty, Q2: site -> empty, Q3: default group -> found
      // Q4: active tariffs fetch, Q5: holidays load
      setupDbResults([], [], [mockGroup], [mockTariffRow], []);

      const result = await resolveTariff('sta_000000000001', null);

      expect(result).toEqual(mockTariffRow);
    });
  });
});
