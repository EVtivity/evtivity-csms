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
  pricingGroups: {},
  driverTokens: {},
  users: {},
  evses: {},
  connectors: {},
  transactionEvents: {},
  tariffs: {},
  pricingGroupStations: {},
  pricingGroupDrivers: {},
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
  listFleets,
  getFleet,
  createFleet,
  updateFleet,
  deleteFleet,
  getFleetDrivers,
  addDriverToFleet,
  removeDriverFromFleet,
  getFleetStations,
  addStationToFleet,
  removeStationFromFleet,
  getFleetVehicles,
  getFleetSessions,
  getFleetMetrics,
  getFleetEnergyHistory,
  getFleetPricingGroup,
  addPricingGroupToFleet,
  removePricingGroupFromFleet,
} from '../services/fleet.service.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('listFleets', () => {
  it('returns data and total with no search', async () => {
    const fleetRows = [{ id: 'f1', name: 'Fleet A', driverCount: 3, stationCount: 2 }];
    setupDbResults(fleetRows, [{ count: 1 }]);

    const result = await listFleets({ page: 1, limit: 10 });

    expect(result.data).toEqual(fleetRows);
    expect(result.total).toBe(1);
  });

  it('returns data and total with search term', async () => {
    const fleetRows = [{ id: 'f2', name: 'Test Fleet' }];
    setupDbResults(fleetRows, [{ count: 1 }]);

    const result = await listFleets({ page: 1, limit: 10, search: 'Test' });

    expect(result.data).toEqual(fleetRows);
    expect(result.total).toBe(1);
  });

  it('returns total 0 when count row is empty', async () => {
    setupDbResults([], []);

    const result = await listFleets({ page: 1, limit: 10 });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('getFleet', () => {
  it('returns fleet when found', async () => {
    const fleet = { id: 'f1', name: 'Fleet A' };
    setupDbResults([fleet]);

    const result = await getFleet('f1');

    expect(result).toEqual(fleet);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await getFleet('nonexistent');

    expect(result).toBeNull();
  });
});

describe('createFleet', () => {
  it('creates and returns fleet', async () => {
    const fleet = { id: 'f1', name: 'New Fleet', description: 'desc' };
    setupDbResults([fleet]);

    const result = await createFleet({ name: 'New Fleet', description: 'desc' });

    expect(result).toEqual(fleet);
  });
});

describe('updateFleet', () => {
  it('returns updated fleet when found', async () => {
    const fleet = { id: 'f1', name: 'Updated' };
    setupDbResults([fleet]);

    const result = await updateFleet('f1', { name: 'Updated' });

    expect(result).toEqual(fleet);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await updateFleet('nonexistent', { name: 'X' });

    expect(result).toBeNull();
  });
});

describe('deleteFleet', () => {
  it('returns deleted fleet when found', async () => {
    const fleet = { id: 'f1', name: 'Deleted' };
    setupDbResults([fleet]);

    const result = await deleteFleet('f1');

    expect(result).toEqual(fleet);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await deleteFleet('nonexistent');

    expect(result).toBeNull();
  });
});

describe('getFleetDrivers', () => {
  it('returns paginated driver list', async () => {
    const drivers = [
      { id: 'd1', firstName: 'John', lastName: 'Doe', email: 'j@d.com', isActive: true },
    ];
    setupDbResults(drivers, [{ count: 1 }]);

    const result = await getFleetDrivers('f1', 1, 10);

    expect(result).toEqual({ data: drivers, total: 1 });
  });
});

describe('addDriverToFleet', () => {
  it('returns created record', async () => {
    const record = { fleetId: 'f1', driverId: 'd1' };
    setupDbResults([record]);

    const result = await addDriverToFleet('f1', 'd1');

    expect(result).toEqual(record);
  });
});

describe('removeDriverFromFleet', () => {
  it('returns removed record when found', async () => {
    const record = { fleetId: 'f1', driverId: 'd1' };
    setupDbResults([record]);

    const result = await removeDriverFromFleet('f1', 'd1');

    expect(result).toEqual(record);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await removeDriverFromFleet('f1', 'd999');

    expect(result).toBeNull();
  });
});

describe('getFleetStations', () => {
  it('returns stations with site names', async () => {
    const stations = [
      {
        id: 's1',
        stationId: 'CS001',
        model: 'Model X',
        availability: 'available',
        isOnline: true,
        siteName: 'Site A',
      },
    ];
    setupDbResults(stations);

    const result = await getFleetStations('f1');

    expect(result).toEqual(stations);
  });
});

describe('addStationToFleet', () => {
  it('returns created record', async () => {
    const record = { fleetId: 'f1', stationId: 's1' };
    setupDbResults([record]);

    const result = await addStationToFleet('f1', 's1');

    expect(result).toEqual(record);
  });
});

describe('removeStationFromFleet', () => {
  it('returns removed record when found', async () => {
    const record = { fleetId: 'f1', stationId: 's1' };
    setupDbResults([record]);

    const result = await removeStationFromFleet('f1', 's1');

    expect(result).toEqual(record);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await removeStationFromFleet('f1', 's999');

    expect(result).toBeNull();
  });
});

describe('getFleetVehicles', () => {
  it('returns paginated vehicles for fleet', async () => {
    const vehicles = [
      {
        id: 'v1',
        driverName: 'John Doe',
        make: 'Tesla',
        model: 'Model 3',
        year: 2023,
        vin: 'ABC123',
        licensePlate: 'XYZ',
      },
    ];
    setupDbResults(vehicles, [{ count: 1 }]);

    const result = await getFleetVehicles('f1', 1, 10);

    expect(result).toEqual({ data: vehicles, total: 1 });
  });
});

describe('getFleetSessions', () => {
  it('returns paginated sessions', async () => {
    const sessions = [{ id: 'sess1', status: 'completed', energyDeliveredWh: 5000 }];
    setupDbResults(sessions, [{ count: 1 }]);

    const result = await getFleetSessions('f1', 1, 10);

    expect(result.data).toEqual(sessions);
    expect(result.total).toBe(1);
  });
});

describe('getFleetMetrics', () => {
  it('returns metrics object with all fields', async () => {
    const sessionStats = {
      totalSessions: 10,
      completedSessions: 8,
      faultedSessions: 1,
      totalEnergyWh: 50000,
      avgDurationMinutes: 45,
      activeDrivers: 3,
    };
    const driverStats = { totalDrivers: 5 };
    const vehicleStats = { totalVehicles: 4 };
    setupDbResults([sessionStats], [driverStats], [vehicleStats]);

    const result = await getFleetMetrics('f1', 6);

    expect(result).toEqual({
      totalSessions: 10,
      completedSessions: 8,
      faultedSessions: 1,
      sessionSuccessPercent: 80,
      totalEnergyWh: 50000,
      avgSessionDurationMinutes: 45,
      activeDrivers: 3,
      totalDrivers: 5,
      totalVehicles: 4,
      periodMonths: 6,
    });
  });

  it('returns defaults when no session data', async () => {
    setupDbResults([undefined], [undefined], [undefined]);

    const result = await getFleetMetrics('f1', 3);

    expect(result.totalSessions).toBe(0);
    expect(result.sessionSuccessPercent).toBe(100);
    expect(result.totalEnergyWh).toBe(0);
    expect(result.totalDrivers).toBe(0);
    expect(result.totalVehicles).toBe(0);
    expect(result.periodMonths).toBe(3);
  });
});

describe('getFleetEnergyHistory', () => {
  it('returns date and energy rows', async () => {
    const rows = [
      { date: '2024-01-01', energyWh: 10000 },
      { date: '2024-01-02', energyWh: 15000 },
    ];
    setupDbResults(rows);

    const result = await getFleetEnergyHistory('f1', 30);

    expect(result).toEqual(rows);
  });
});

describe('getFleetPricingGroup', () => {
  it('returns single pricing group for fleet', async () => {
    const group = {
      id: 'pg1',
      name: 'Standard',
      description: 'Default pricing',
      isDefault: true,
      tariffCount: 2,
    };
    setupDbResults([group]);

    const result = await getFleetPricingGroup('f1');

    expect(result).toEqual(group);
  });

  it('returns null when no pricing group assigned', async () => {
    setupDbResults([]);

    const result = await getFleetPricingGroup('f1');

    expect(result).toBeNull();
  });
});

describe('addPricingGroupToFleet', () => {
  it('returns created record', async () => {
    const record = { fleetId: 'f1', pricingGroupId: 'pg1' };
    setupDbResults([record]);

    const result = await addPricingGroupToFleet('f1', 'pg1');

    expect(result).toEqual(record);
  });
});

describe('removePricingGroupFromFleet', () => {
  it('returns removed record when found', async () => {
    const record = { fleetId: 'f1', pricingGroupId: 'pg1' };
    setupDbResults([record]);

    const result = await removePricingGroupFromFleet('f1', 'pg1');

    expect(result).toEqual(record);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await removePricingGroupFromFleet('f1', 'pg999');

    expect(result).toBeNull();
  });
});
