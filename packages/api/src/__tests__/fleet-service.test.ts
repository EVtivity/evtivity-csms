// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    'onConflictDoNothing',
    'delete',
    'for',
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

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'status'),
  buildStatusReasonSubquery: vi.fn(() => null),
}));

const {
  mockWriteAudit,
  mockNotifyChange,
  mockPublishFanout,
  mockReleaseUpgradePending,
  mockLoadExposure,
} = vi.hoisted(() => ({
  mockWriteAudit: vi.fn(),
  mockNotifyChange: vi.fn(),
  mockPublishFanout: vi.fn(),
  mockReleaseUpgradePending: vi.fn(),
  mockLoadExposure: vi.fn(),
}));

vi.mock('../lib/provider-switch.js', () => ({ providerSwitchStore: () => 'watchStore' }));

vi.mock('@evtivity/services/fleet-billing-notice', () => ({
  notifyAccountBillingChange: mockNotifyChange,
  publishFleetBillingFanout: mockPublishFanout,
}));

vi.mock('@evtivity/database', () => ({
  client: 'client',
  writeAudit: mockWriteAudit,
  releaseUpgradePending: mockReleaseUpgradePending,
  ACCOUNT_BILLING_MIN_VERSION: '0.1.41',
  guardVersion: (min: string) => min,
  loadFleetCreditExposure: mockLoadExposure,
  fleetCreditLevel: (exposure: number, limit: number, percent: number) =>
    exposure >= limit ? 'reached' : exposure * 100 >= limit * percent ? 'warning' : 'ok',
  fleetAuditLog: 'fleetAuditLog',
  pgErrorCode: (err: unknown) => (err as { code?: string }).code,
  PG_FOREIGN_KEY_VIOLATION: '23503',
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
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
  ne: vi.fn(),
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
  searchAvailableVehicles,
  getFleetSessions,
  getFleetMetrics,
  getFleetEnergyHistory,
  getFleetPricingGroup,
  addPricingGroupToFleet,
  removePricingGroupFromFleet,
  setFleetAccountBilling,
  getFleetCreditLimit,
  setFleetCreditLimit,
  setMemberBillingOptOut,
  notifyMemberJoined,
  notifyMemberLeft,
  FleetBillingUpgradePendingError,
  updateFleetBillingProfile,
  mergeBillingProfile,
  diffBillingProfile,
} from '../services/fleet.service.js';
import type { FleetBillingProfile } from '../services/fleet.service.js';
import { db } from '@evtivity/database';

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
    setupDbResults([], [fleet]);

    const result = await deleteFleet('f1');

    expect(result).toEqual(fleet);
  });

  it('returns null when not found', async () => {
    setupDbResults([], []);

    const result = await deleteFleet('nonexistent');

    expect(result).toBeNull();
  });

  it('refuses with 409 FLEET_HAS_OPEN_BILLING while sessions are billed to the fleet', async () => {
    setupDbResults([{ id: 'ses_1' }]);

    await expect(deleteFleet('f1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'FLEET_HAS_OPEN_BILLING',
    });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('answers a session stamped between the check and the delete with 409', async () => {
    setupDbResults([]);
    vi.mocked(db.delete).mockImplementationOnce(() => {
      throw Object.assign(new Error('fk'), { code: '23503' });
    });

    await expect(deleteFleet('f1')).rejects.toMatchObject({ code: 'FLEET_HAS_OPEN_BILLING' });
  });
});

describe('fleet account billing', () => {
  const log = { warn: vi.fn() } as never;
  const actor = {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  };

  beforeEach(() => {
    mockNotifyChange.mockResolvedValue(true);
    mockPublishFanout.mockResolvedValue(undefined);
    mockReleaseUpgradePending.mockResolvedValue(null);
  });

  it('turns account billing on: audits once and hands the member notices to the worker', async () => {
    const updatedAt = new Date('2026-10-07T12:00:00.000Z');
    const fleet = { id: 'f1', name: 'Acme', accountBillingEnabled: true, updatedAt };
    setupDbResults([{ ...fleet, accountBillingEnabled: false }], [fleet]);

    expect(await setFleetAccountBilling('f1', true, { actor, log })).toEqual(fleet);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: 'fleetAuditLog', idColumn: 'fleet_id' },
      expect.objectContaining({
        entityId: 'f1',
        action: 'billing_updated',
        before: { accountBillingEnabled: false },
        after: { accountBillingEnabled: true },
      }),
      db,
      log,
    );
    // No member is notified inside the request: one fan-out job per change.
    expect(mockPublishFanout).toHaveBeenCalledWith(
      { fleetId: 'f1', enabled: true, changedAt: updatedAt.toISOString() },
      log,
    );
    expect(mockNotifyChange).not.toHaveBeenCalled();
    expect(mockReleaseUpgradePending).toHaveBeenCalledWith('0.1.41', 'watchStore');
  });

  it('refuses to turn account billing on while processes before v0.1.41 may run', async () => {
    const details = {
      oldConnections: 2,
      hosts: ['10.0.0.8'],
      lastOldSeenAt: '2026-10-07T11:59:00.000Z',
      watchCheckedAt: '2026-10-07T11:59:30.000Z',
    };
    mockReleaseUpgradePending.mockResolvedValue(details);
    setupDbResults([{ id: 'f1', name: 'Acme', accountBillingEnabled: false }]);

    const err = await setFleetAccountBilling('f1', true, { actor, log }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetBillingUpgradePendingError);
    expect(err).toMatchObject({
      statusCode: 409,
      code: 'FLEET_BILLING_OLD_PODS_CONNECTED',
      details,
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('turns account billing off without the release guard', async () => {
    const fleet = { id: 'f1', name: 'Acme', accountBillingEnabled: false, updatedAt: new Date() };
    mockReleaseUpgradePending.mockResolvedValue({ oldConnections: 1 });
    setupDbResults([fleet]);

    expect(await setFleetAccountBilling('f1', false, { actor, log })).toEqual(fleet);
    expect(mockReleaseUpgradePending).not.toHaveBeenCalled();
  });

  it('a request that changes nothing audits and publishes nothing (once per change)', async () => {
    const fleet = { id: 'f1', name: 'Acme', accountBillingEnabled: true };
    setupDbResults([fleet]);

    expect(await setFleetAccountBilling('f1', true, { actor, log })).toEqual(fleet);
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockPublishFanout).not.toHaveBeenCalled();
    expect(mockReleaseUpgradePending).not.toHaveBeenCalled();
    setupDbResults([], [fleet]);
    expect(await setFleetAccountBilling('f1', false, { actor, log })).toEqual(fleet);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('returns null for an unknown fleet', async () => {
    setupDbResults([]);
    expect(await setFleetAccountBilling('nope', true, { actor, log })).toBeNull();
    setupDbResults([], []);
    expect(await setFleetAccountBilling('nope', false, { actor, log })).toBeNull();
  });

  it('opts a member out: audits and asks the notice to compare before and after', async () => {
    const record = { fleetId: 'f1', driverId: 'd1', accountBillingOptOut: true };
    setupDbResults([record]);

    expect(await setMemberBillingOptOut('f1', 'd1', true, { actor, log })).toEqual(record);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'member_billing_opt_out_changed',
        before: { driverId: 'd1', accountBillingOptOut: false },
        after: { driverId: 'd1', accountBillingOptOut: true },
      }),
      db,
      log,
    );
    expect(mockNotifyChange).toHaveBeenCalledWith(
      'client',
      'd1',
      { kind: 'optOut', fleetId: 'f1', optOut: true },
      log,
    );
  });

  it('an unchanged opt-out returns the membership without audit or notice, a non-member null', async () => {
    const record = { fleetId: 'f1', driverId: 'd1', accountBillingOptOut: false };
    setupDbResults([], [record]);
    expect(await setMemberBillingOptOut('f1', 'd1', false, { actor, log })).toEqual(record);
    setupDbResults([], []);
    expect(await setMemberBillingOptOut('f1', 'dx', false, { actor, log })).toBeNull();
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockNotifyChange).not.toHaveBeenCalled();
  });

  it('notifies a member who joined or left through the before and after comparison', async () => {
    await notifyMemberJoined('f1', 'd1', log);
    expect(mockNotifyChange).toHaveBeenCalledWith(
      'client',
      'd1',
      { kind: 'joined', fleetId: 'f1' },
      log,
    );

    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    setupDbResults([{ id: 'f1', name: 'Acme', accountBillingEnabled: true }]);
    await notifyMemberLeft(
      { id: 7, fleetId: 'f1', driverId: 'd1', accountBillingOptOut: false, createdAt },
      log,
    );
    expect(mockNotifyChange).toHaveBeenLastCalledWith(
      'client',
      'd1',
      {
        kind: 'left',
        membership: {
          membershipId: 7,
          fleetId: 'f1',
          fleetName: 'Acme',
          accountBillingEnabled: true,
          optOut: false,
          createdAt,
        },
      },
      log,
    );
  });
});

describe('fleet billing profile', () => {
  const log = { warn: vi.fn() } as never;
  const actor = {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  };
  const profile: FleetBillingProfile = {
    billingContactEmails: [],
    billingLegalName: null,
    billingStreet: null,
    billingCity: null,
    billingState: null,
    billingZip: null,
    billingCountry: null,
    billingTaxId: null,
    invoiceLanguage: 'en',
    paymentTermsDays: null,
    autoInvoice: false,
  };
  const fleetRow = { id: 'f1', name: 'Acme', accountBillingEnabled: true, ...profile };

  it('merges a patch: trims text, blank clears, emails lowercased without duplicates', () => {
    const next = mergeBillingProfile(
      { ...profile, billingCity: 'Berlin', billingTaxId: 'DE123' },
      {
        billingLegalName: '  Acme GmbH ',
        billingTaxId: '  ',
        billingStreet: null,
        billingContactEmails: [' AP@Acme.example ', 'ap@acme.example', 'cfo@acme.example'],
        paymentTermsDays: 14,
      },
    );
    expect(next).toEqual({
      ...profile,
      billingLegalName: 'Acme GmbH',
      billingCity: 'Berlin',
      billingTaxId: null,
      billingContactEmails: ['ap@acme.example', 'cfo@acme.example'],
      paymentTermsDays: 14,
    });
  });

  it('diffs only the changed keys and returns null when nothing changed', () => {
    expect(diffBillingProfile(profile, { ...profile })).toBeNull();
    expect(
      diffBillingProfile(profile, {
        ...profile,
        billingContactEmails: ['ap@acme.example'],
        invoiceLanguage: 'de',
      }),
    ).toEqual({
      before: { billingContactEmails: [], invoiceLanguage: 'en' },
      after: { billingContactEmails: ['ap@acme.example'], invoiceLanguage: 'de' },
    });
  });

  it('updates the changed keys and audits before and after', async () => {
    const updated = {
      ...fleetRow,
      billingContactEmails: ['ap@acme.example'],
      autoInvoice: true,
      paymentTermsDays: 14,
    };
    setupDbResults([fleetRow], [updated]);

    const result = await updateFleetBillingProfile(
      'f1',
      { billingContactEmails: ['AP@acme.example'], autoInvoice: true, paymentTermsDays: 14 },
      { actor, log },
    );

    expect(result).toEqual(updated);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: 'fleetAuditLog', idColumn: 'fleet_id' },
      expect.objectContaining({
        entityId: 'f1',
        action: 'billing_updated',
        actorUserId: 'usr_1',
        before: { billingContactEmails: [], paymentTermsDays: null, autoInvoice: false },
        after: {
          billingContactEmails: ['ap@acme.example'],
          paymentTermsDays: 14,
          autoInvoice: true,
        },
      }),
      db,
      log,
    );
  });

  it('a request that changes nothing writes and audits nothing', async () => {
    setupDbResults([fleetRow]);

    const result = await updateFleetBillingProfile(
      'f1',
      { invoiceLanguage: 'en', billingCity: '  ' },
      { actor, log },
    );

    expect(result).toEqual(fleetRow);
    expect(dbCallIndex).toBe(1); // only the locked read, no UPDATE
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('refuses automatic invoicing without a billing contact', async () => {
    setupDbResults([fleetRow]);
    const err = await updateFleetBillingProfile('f1', { autoInvoice: true }, { actor, log }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ statusCode: 400, code: 'FLEET_BILLING_CONTACT_REQUIRED' });
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('refuses removing the last contact while automatic invoicing is on', async () => {
    setupDbResults([{ ...fleetRow, billingContactEmails: ['ap@acme.example'], autoInvoice: true }]);
    const err = await updateFleetBillingProfile(
      'f1',
      { billingContactEmails: [] },
      { actor, log },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FLEET_BILLING_CONTACT_REQUIRED' });
  });

  it('returns null for an unknown fleet', async () => {
    setupDbResults([]);
    expect(
      await updateFleetBillingProfile('nope', { autoInvoice: false }, { actor, log }),
    ).toBeNull();
    expect(mockWriteAudit).not.toHaveBeenCalled();
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

describe('searchAvailableVehicles', () => {
  it('returns vehicles not yet assigned to the fleet matching the search', async () => {
    const rows = [
      {
        id: 'v2',
        driverId: 'd2',
        driverName: 'Jane Roe',
        make: 'Rivian',
        model: 'R1T',
        year: 2024,
        vin: 'RIV999',
        licensePlate: 'EV-2',
      },
    ];
    setupDbResults(rows);

    const result = await searchAvailableVehicles('f1', 'Rivian', 25);

    expect(result).toEqual(rows);
  });

  it('returns an empty list when nothing matches', async () => {
    setupDbResults([]);

    const result = await searchAvailableVehicles('f1', 'no-such-vehicle', 25);

    expect(result).toEqual([]);
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

describe('fleet credit limit', () => {
  const log = { warn: vi.fn() } as never;
  const actor = {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  };
  const exposure = {
    unbilledCents: 6000,
    invoicedCents: 2000,
    runningCents: 500,
    totalCents: 8500,
    currency: 'EUR',
  };

  const defaultTransaction = vi.mocked(db.transaction).getMockImplementation();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadExposure.mockResolvedValue(exposure);
  });

  afterEach(() => {
    if (defaultTransaction != null) {
      vi.mocked(db.transaction).mockImplementation(defaultTransaction);
    }
  });

  it('returns the limit, the exposure and its level', async () => {
    setupDbResults([{ creditLimitCents: 10_000, warningPercent: 80 }]);
    expect(await getFleetCreditLimit('f1')).toEqual({
      creditLimitCents: 10_000,
      warningPercent: 80,
      exposure,
      level: 'warning',
    });
    expect(mockLoadExposure).toHaveBeenCalledWith('client', 'f1');
  });

  it('has no level without a limit', async () => {
    setupDbResults([{ creditLimitCents: null, warningPercent: 80 }]);
    expect((await getFleetCreditLimit('f1'))?.level).toBeNull();
  });

  it('returns null for an unknown fleet', async () => {
    setupDbResults([], []);
    expect(await getFleetCreditLimit('f1')).toBeNull();
    expect(await setFleetCreditLimit('f1', { creditLimitCents: 5000 }, { actor, log })).toBeNull();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  /**
   * A fake transaction over one fleet row. Transactions run one at a time, like
   * the row lock serializes them: the locked SELECT reads the row as the
   * previous transaction left it, and each UPDATE records its SET and applies it.
   */
  function fakeLockedFleet(row: {
    creditLimitCents: number | null;
    creditLimitWarningPercent: number;
  }) {
    const sets: Record<string, unknown>[] = [];
    const forCalls: string[] = [];
    let queue: Promise<unknown> = Promise.resolve();
    vi.mocked(db.transaction).mockImplementation(((fn: (tx: unknown) => Promise<unknown>) => {
      const run = queue.then(() => {
        const tx = {
          select: vi.fn(() => {
            const chain: Record<string, unknown> = {};
            chain['from'] = () => chain;
            chain['where'] = () => chain;
            chain['for'] = (mode: string) => {
              forCalls.push(mode);
              return Promise.resolve([{ ...row }]);
            };
            return chain;
          }),
          update: vi.fn(() => {
            const chain: Record<string, unknown> = {};
            chain['set'] = (values: Record<string, unknown>) => {
              sets.push(values);
              return chain;
            };
            chain['where'] = () => {
              const last = sets[sets.length - 1] ?? {};
              for (const key of ['creditLimitCents', 'creditLimitWarningPercent'] as const) {
                if (key in last) Object.assign(row, { [key]: last[key] });
              }
              return Promise.resolve([]);
            };
            return chain;
          }),
        };
        return fn(tx);
      });
      queue = run.catch(() => undefined);
      return run;
    }) as never);
    return { row, sets, forCalls };
  }

  it('sets the limit under the row lock and audits the change with before and after', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: null, creditLimitWarningPercent: 80 });
    setupDbResults([{ creditLimitCents: 8000, warningPercent: 90 }]);

    const view = await setFleetCreditLimit(
      'f1',
      { creditLimitCents: 8000, warningPercent: 90 },
      { actor, log },
    );

    expect(view?.level).toBe('reached');
    expect(fake.forCalls).toEqual(['update']);
    expect(fake.sets).toEqual([
      { creditLimitCents: 8000, creditLimitWarningPercent: 90, updatedAt: expect.any(Date) },
    ]);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: 'fleetAuditLog', idColumn: 'fleet_id' },
      expect.objectContaining({
        entityId: 'f1',
        action: 'billing_updated',
        before: { creditLimitCents: null, creditLimitWarningPercent: 80 },
        after: { creditLimitCents: 8000, creditLimitWarningPercent: 90 },
      }),
      db,
      log,
    );
  });

  it('keeps a value left out and writes and audits only the changed key', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: 8000, creditLimitWarningPercent: 80 });
    setupDbResults([{ creditLimitCents: 8000, warningPercent: 70 }]);

    await setFleetCreditLimit('f1', { warningPercent: 70 }, { actor, log });

    expect(fake.sets).toEqual([{ creditLimitWarningPercent: 70, updatedAt: expect.any(Date) }]);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        before: { creditLimitWarningPercent: 80 },
        after: { creditLimitWarningPercent: 70 },
      }),
      db,
      log,
    );
  });

  it('removes the limit with null', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: 8000, creditLimitWarningPercent: 80 });
    setupDbResults([{ creditLimitCents: null, warningPercent: 80 }]);

    const view = await setFleetCreditLimit('f1', { creditLimitCents: null }, { actor, log });

    expect(view?.level).toBeNull();
    expect(fake.row.creditLimitCents).toBeNull();
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        before: { creditLimitCents: 8000 },
        after: { creditLimitCents: null },
      }),
      db,
      log,
    );
  });

  it('a request that changes nothing updates and audits nothing (P7)', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: 8000, creditLimitWarningPercent: 80 });
    setupDbResults([{ creditLimitCents: 8000, warningPercent: 80 }]);

    await setFleetCreditLimit('f1', { creditLimitCents: 8000, warningPercent: 80 }, { actor, log });

    expect(fake.sets).toEqual([]);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('two concurrent requests that each set one value keep both values', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: null, creditLimitWarningPercent: 80 });
    setupDbResults(
      [{ creditLimitCents: 8000, warningPercent: 70 }],
      [{ creditLimitCents: 8000, warningPercent: 70 }],
    );

    await Promise.all([
      setFleetCreditLimit('f1', { creditLimitCents: 8000 }, { actor, log }),
      setFleetCreditLimit('f1', { warningPercent: 70 }, { actor, log }),
    ]);

    expect(fake.row).toEqual({ creditLimitCents: 8000, creditLimitWarningPercent: 70 });
    expect(fake.forCalls).toEqual(['update', 'update']);
    expect(fake.sets).toEqual([
      { creditLimitCents: 8000, updatedAt: expect.any(Date) },
      { creditLimitWarningPercent: 70, updatedAt: expect.any(Date) },
    ]);
    const audits = mockWriteAudit.mock.calls.map((c) => (c as unknown[])[1]);
    expect(audits).toEqual([
      expect.objectContaining({
        before: { creditLimitCents: null },
        after: { creditLimitCents: 8000 },
      }),
      expect.objectContaining({
        before: { creditLimitWarningPercent: 80 },
        after: { creditLimitWarningPercent: 70 },
      }),
    ]);
  });

  it('audits nothing when a concurrent request already wrote the same value', async () => {
    const fake = fakeLockedFleet({ creditLimitCents: null, creditLimitWarningPercent: 80 });
    setupDbResults(
      [{ creditLimitCents: 8000, warningPercent: 80 }],
      [{ creditLimitCents: 8000, warningPercent: 80 }],
    );

    await Promise.all([
      setFleetCreditLimit('f1', { creditLimitCents: 8000 }, { actor, log }),
      setFleetCreditLimit('f1', { creditLimitCents: 8000 }, { actor, log }),
    ]);

    expect(fake.sets).toHaveLength(1);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
  });
});
