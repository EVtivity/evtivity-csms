// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

/** The driver row a driver's update reads FOR SHARE on the locked token (PP-L1). */
const OWNER_ROW = { isActive: true, erasedAt: null };
// A fleet that bills on account, read FOR SHARE before a fleet card write.
const FLEET_ROW = { id: 'flt_1', accountBillingEnabled: true };

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
    'for',
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

vi.mock('@evtivity/database', async () => ({
  // The real SQLSTATE readers, so the mocked errors map as in production.
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
  currentAuditViaAi: () => undefined,
  isDriverRfidSelfServiceEnabled: vi.fn(async () => true),
  isFleetEnabled: vi.fn(async () => true),
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
  client: {},
  driverTokens: {
    id: 'id',
    driverId: 'driverId',
    idToken: 'idToken',
    tokenType: 'tokenType',
    label: 'label',
    isActive: 'isActive',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  drivers: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
  },
  users: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
  },
  pncContracts: { driverTokenId: 'driverTokenId', status: 'status' },
  fleets: { id: 'fleets.id', name: 'fleets.name' },
  fleetDrivers: { id: 'fd.id', fleetId: 'fd.fleetId', driverId: 'fd.driverId' },
  driverTokenTombstones: { idToken: 'idToken', tokenType: 'tokenType' },
  tokenAuditLog: {
    id: 'id',
    tokenId: 'tokenId',
    idTokenSnapshot: 'idTokenSnapshot',
    tokenTypeSnapshot: 'tokenTypeSnapshot',
    driverIdSnapshot: 'driverIdSnapshot',
    action: 'action',
    actor: 'actor',
    actorUserId: 'actorUserId',
    actorDriverId: 'actorDriverId',
    notes: 'notes',
    createdAt: 'createdAt',
  },
  stationLocalAuthEntries: {
    stationId: 'stationId',
    driverTokenId: 'driverTokenId',
  },
  vehicles: { id: 'id', driverId: 'driverId', vin: 'vin', evccid: 'evccid' },
  stationLocalAuthVersions: {
    stationId: 'stationId',
    lastModifiedAt: 'lastModifiedAt',
  },
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  ne: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: vi.fn().mockResolvedValue(undefined),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

const siteScope = vi.hoisted(() => ({ allSites: true, fleetUser: false }));
vi.mock('../lib/site-access.js', () => ({
  isAllSiteUser: vi.fn(() => Promise.resolve(siteScope.allSites)),
}));
vi.mock('../lib/fleet-scope.js', () => ({
  isFleetUser: vi.fn(() => Promise.resolve(siteScope.fleetUser)),
}));

const publishOcpiTokenPushMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/ocpi-token-push.js', () => ({
  publishOcpiTokenPush: (...args: unknown[]) => publishOcpiTokenPushMock(...args) as unknown,
}));

import {
  listTokens,
  getToken,
  createToken,
  updateToken,
  deleteToken,
  bulkSetActive,
  exportTokensCsv,
  importTokensCsv,
  hasEmailShape,
  normalizeTokenLabel,
  clearDriverTokenLabels,
  DuplicateTokenError,
  VehicleIdTokenInUseError,
  VehicleShapedCardError,
  PrepaidBalanceConflictError,
  PrepaidBalanceExpectedError,
  TokenDriverNotFoundError,
  TokenDriverInactiveError,
  TokenReactivationBlockedError,
  FleetCardDeactivatedError,
  FleetCardRevokeRefusedError,
  RfidSelfServiceDisabledError,
  PncContractTokenError,
  TokenFleetNotFoundError,
  FleetCardDriverNotMemberError,
  FleetCardNotBillableError,
  FleetCardPermissionError,
  TokenManagedByFleetError,
  FleetCardSiteScopeError,
  FLEET_CARD_RELEASE_REASON,
  releaseMemberFleetCards,
  markFleetCardListsChanged,
  tokenActorOf,
} from '../services/token.service.js';
import { dispatchDriverNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import * as databaseModule from '@evtivity/database';
import { isFleetEnabled } from '@evtivity/database';
import { tokenLabelProblem } from '../lib/token-label.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  siteScope.allSites = true;
  siteScope.fleetUser = false;
  vi.clearAllMocks();
});

describe('listTokens', () => {
  it('returns data and total without search', async () => {
    const tokenRows = [{ id: 't1', idToken: 'TOKEN1', tokenType: 'ISO14443', isActive: true }];
    setupDbResults(tokenRows, [{ count: 1 }]);

    const result = await listTokens({ page: 1, limit: 10 });

    expect(result.data).toEqual(tokenRows);
    expect(result.total).toBe(1);
  });

  it('returns data and total with search', async () => {
    const tokenRows = [{ id: 't2', idToken: 'SEARCH_HIT', tokenType: 'ISO14443', isActive: true }];
    setupDbResults(tokenRows, [{ count: 1 }]);

    const result = await listTokens({ page: 1, limit: 10, search: 'SEARCH' });

    expect(result.data).toEqual(tokenRows);
    expect(result.total).toBe(1);
  });

  it('matches LIKE wildcards in the search only as typed, the label included (PP-I1)', async () => {
    const { ilike } = await import('drizzle-orm');
    vi.mocked(ilike).mockClear();
    setupDbResults([], [{ count: 0 }]);
    await listTokens({ page: 1, limit: 10, search: '50%_off\\' });
    const patterns = vi.mocked(ilike).mock.calls.map((c) => c[1]);
    // idToken, label, first name, last name, email: each escaped.
    expect(patterns.length).toBeGreaterThanOrEqual(5);
    for (const p of patterns) expect(p).toBe('%50\\%\\_off\\\\%');
  });

  it('applies tokenType and status filters', async () => {
    const tokenRows = [{ id: 't3', idToken: 'TYPED', tokenType: 'KeyCode', isActive: true }];
    setupDbResults(tokenRows, [{ count: 1 }]);

    const result = await listTokens({
      page: 1,
      limit: 10,
      tokenType: 'KeyCode',
      status: 'active',
    });

    expect(result.data).toEqual(tokenRows);
    expect(result.total).toBe(1);
  });

  it('filters by inactive status', async () => {
    setupDbResults([], [{ count: 0 }]);

    const result = await listTokens({ page: 1, limit: 10, status: 'inactive' });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('getToken', () => {
  it('returns token when found', async () => {
    const token = { id: 't1', idToken: 'TOKEN1', tokenType: 'ISO14443' };
    setupDbResults([token]);

    const result = await getToken('t1');

    expect(result).toEqual(token);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await getToken('nonexistent');

    expect(result).toBeNull();
  });
});

describe('prepaid balance compare-and-set is required (PP2 Info 3)', () => {
  it('refuses a balance change without the expected value, before any read', async () => {
    setupDbResults();
    await expect(updateToken('t1', { prepaidBalanceCents: 6000 })).rejects.toBeInstanceOf(
      PrepaidBalanceExpectedError,
    );
    await expect(updateToken('t1', { prepaidBalanceCents: null })).rejects.toBeInstanceOf(
      PrepaidBalanceExpectedError,
    );
  });
});

describe('createToken', () => {
  it('returns created token', async () => {
    const token = { id: 't1', idToken: 'NEW_TOKEN', tokenType: 'ISO14443', driverId: null };
    // dup check (empty), another driver's vehicle with the value (none), insert
    // returning, writeAudit insert (no result needed), publishTokenChanged is
    // async pubsub call (no DB)
    setupDbResults([], [], [token]);

    const result = await createToken({ idToken: 'NEW_TOKEN', tokenType: 'ISO14443' });

    expect(result).toEqual(token);
  });

  it('refuses a vehicle-shaped card value from a driver before any lookup', async () => {
    for (const idToken of ['92D50A693F80', '92-d5-0a-69-3f-80', '5YJ3E1EA7KF317000']) {
      setupDbResults();
      await expect(
        createToken(
          { driverId: 'd1', idToken, tokenType: 'ISO14443' },
          { type: 'driver', driverId: 'd1' },
        ),
      ).rejects.toBeInstanceOf(VehicleShapedCardError);
    }
    // Operators keep every value.
    const token = { id: 't1', idToken: '92D50A693F80', tokenType: 'ISO14443', driverId: null };
    setupDbResults([], [], [token]);
    await expect(
      createToken({ idToken: '92D50A693F80', tokenType: 'ISO14443' }, { type: 'system' }),
    ).resolves.toEqual(token);
  });

  it("binds a card to a vehicle of the card's driver only", async () => {
    const token = { id: 't3', idToken: 'BUS', tokenType: 'ISO14443', driverId: 'drv_1' };
    // existing check, the driver (active), no vehicle id clash, the vehicle of the driver, insert
    setupDbResults([], [{ isActive: true }], [], [{ id: 'veh_1' }], [token]);
    await expect(
      createToken({ idToken: 'BUS', tokenType: 'ISO14443', driverId: 'drv_1', vehicleId: 'veh_1' }),
    ).resolves.toEqual(token);

    // Another driver's vehicle: the vehicle lookup finds none for this driver.
    setupDbResults([], [{ isActive: true }], [], []);
    await expect(
      createToken({ idToken: 'BUS', tokenType: 'ISO14443', driverId: 'drv_1', vehicleId: 'veh_9' }),
    ).rejects.toThrow("The vehicle is not one of the card driver's vehicles");

    // A card without a driver cannot belong to a vehicle.
    setupDbResults([], []);
    await expect(
      createToken({ idToken: 'BUS', tokenType: 'ISO14443', vehicleId: 'veh_1' }),
    ).rejects.toThrow('A card without a driver cannot belong to a vehicle');
  });

  it('throws DuplicateTokenError when (idToken, tokenType) already exists', async () => {
    setupDbResults([{ id: 'existing' }]);

    await expect(
      createToken({ idToken: 'NEW_TOKEN', tokenType: 'ISO14443' }),
    ).rejects.toBeInstanceOf(DuplicateTokenError);
  });

  it('allows the same idToken under a different tokenType', async () => {
    const token = { id: 't2', idToken: 'SAME_UID', tokenType: 'ISO15693', driverId: null };
    // dup check on (SAME_UID, ISO15693) returns empty, no vehicle with the
    // value, then insert returning
    setupDbResults([], [], [token]);

    const result = await createToken({ idToken: 'SAME_UID', tokenType: 'ISO15693' });

    expect(result).toEqual(token);
  });

  it('notifies the driver and fires SSE when a token is created with a driver', async () => {
    const token = {
      id: 't9',
      idToken: 'DRIVER_TOKEN',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
    };
    // existing check (none), the driver (active), no vehicle, insert returning
    setupDbResults([], [{ isActive: true }], [], [token]);

    const result = await createToken(
      { idToken: 'DRIVER_TOKEN', tokenType: 'ISO14443', driverId: 'drv_1' },
      { type: 'operator', userId: 'usr_1' },
    );

    expect(result).toEqual(token);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Added',
      'drv_1',
      expect.objectContaining({
        idToken: 'DRIVER_TOKEN',
        tokenType: 'ISO14443',
        addedBy: 'operator',
      }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });

  it('reactivates an existing inactive token belonging to the same driver', async () => {
    // 1. dup check: existing inactive row for same driver
    // 2. updateToken: select current row
    // 3. updateToken: update returning (reactivated)
    // 4. bumpStationsHoldingToken: select entries (empty -> no version bump)
    const existing = { id: 't1', driverId: 'drv_1', isActive: false };
    const reactivated = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: true,
    };
    const currentRow = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'driver',
    };
    // existing row, current (locked), the driver actor (FOR SHARE), the driver
    // (active), update returning, stations holding the token
    setupDbResults([existing], [currentRow], [OWNER_ROW], [{ isActive: true }], [reactivated], []);

    const result = await createToken(
      { idToken: 'RFID-1', tokenType: 'ISO14443', driverId: 'drv_1' },
      { type: 'driver', driverId: 'drv_1' },
    );

    expect(result).toEqual(reactivated);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Reactivated',
      'drv_1',
      expect.objectContaining({ reactivatedBy: 'you' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });

  it("re-adds a card with its vehicle checked like an update: another driver's vehicle is refused", async () => {
    const existing = { id: 't1', driverId: 'drv_1', isActive: false };
    const currentRow = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'operator',
      vehicleId: null,
    };
    // existing row, current (locked), the driver (active), the vehicle lookup for drv_1 (none)
    setupDbResults([existing], [currentRow], [{ isActive: true }], []);
    await expect(
      createToken({
        idToken: 'RFID-1',
        tokenType: 'ISO14443',
        driverId: 'drv_1',
        vehicleId: 'veh_9',
      }),
    ).rejects.toThrow("The vehicle is not one of the card driver's vehicles");
  });

  it("re-adds a card with a vehicle of the card's driver", async () => {
    const existing = { id: 't1', driverId: 'drv_1', isActive: false };
    const currentRow = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'operator',
      vehicleId: null,
    };
    const reactivated = { ...currentRow, isActive: true, vehicleId: 'veh_1' };
    setupDbResults(
      [existing],
      [currentRow],
      [{ isActive: true }],
      [{ id: 'veh_1' }],
      [reactivated],
      [],
    );
    const result = await createToken({
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      vehicleId: 'veh_1',
    });
    expect(result).toMatchObject({ isActive: true, vehicleId: 'veh_1' });
  });

  it('throws DuplicateTokenError when an existing token belongs to a different driver', async () => {
    setupDbResults([{ id: 't1', driverId: 'drv_other', isActive: false }]);

    await expect(
      createToken(
        { idToken: 'RFID-1', tokenType: 'ISO14443', driverId: 'drv_1' },
        { type: 'driver', driverId: 'drv_1' },
      ),
    ).rejects.toBeInstanceOf(DuplicateTokenError);
  });

  it('maps a postgres 23505 unique violation on insert to DuplicateTokenError', async () => {
    // dup pre-check returns empty, but the insert throws a unique-violation as
    // a concurrent insert won the TOCTOU race.
    setupDbResults([]);
    const { db } = databaseModule;
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    vi.mocked(db.insert).mockImplementationOnce(
      () =>
        ({
          values: () => ({
            returning: () => Promise.reject(uniqueErr),
          }),
        }) as never,
    );

    await expect(createToken({ idToken: 'RACE', tokenType: 'ISO14443' })).rejects.toBeInstanceOf(
      DuplicateTokenError,
    );
  });

  it('rethrows non-unique-violation insert errors', async () => {
    setupDbResults([]);
    const { db } = databaseModule;
    const otherErr = new Error('connection lost');
    vi.mocked(db.insert).mockImplementationOnce(
      () =>
        ({
          values: () => ({
            returning: () => Promise.reject(otherErr),
          }),
        }) as never,
    );

    await expect(createToken({ idToken: 'X', tokenType: 'ISO14443' })).rejects.toThrow(
      'connection lost',
    );
  });

  it('returns null when the insert returns no row', async () => {
    setupDbResults([], []);

    const result = await createToken({ idToken: 'NONE', tokenType: 'ISO14443' });

    expect(result).toBeNull();
  });
});

describe('vehicle ids of other drivers', () => {
  it("refuses an operator's card holding another driver's vehicle id", async () => {
    // dup check (none), the driver (active), a vehicle of another driver
    setupDbResults([], [{ isActive: true }], [{ id: 'veh_1' }]);
    await expect(
      createToken(
        { idToken: 'VID:92D50A693F80', tokenType: 'ISO14443', driverId: 'drv_1' },
        { type: 'operator', userId: 'usr_1' },
      ),
    ).rejects.toBeInstanceOf(VehicleIdTokenInUseError);
  });

  it('refuses a rename to another driver vehicle id', async () => {
    // current-row SELECT, dup check (empty), a vehicle of another driver
    setupDbResults([{ idToken: 'OLD', tokenType: 'ISO14443' }], [], [{ id: 'veh_1' }]);
    await expect(updateToken('t1', { idToken: '92-D5-0A-69-3F-80' })).rejects.toBeInstanceOf(
      VehicleIdTokenInUseError,
    );
  });
});

describe('prepaid balance compare-and-set', () => {
  it('refuses a balance change based on a stale balance', async () => {
    setupDbResults([{ idToken: 'P', tokenType: 'ISO14443', prepaidBalanceCents: 2000 }]);
    await expect(
      updateToken('t1', { prepaidBalanceCents: 6000, expectedPrepaidBalanceCents: 5000 }),
    ).rejects.toBeInstanceOf(PrepaidBalanceConflictError);
  });

  it('applies a balance change based on the stored balance', async () => {
    const token = { id: 't1', idToken: 'P', tokenType: 'ISO14443', prepaidBalanceCents: 6000 };
    setupDbResults([{ idToken: 'P', tokenType: 'ISO14443', prepaidBalanceCents: 2000 }], [token]);
    const result = await updateToken('t1', {
      prepaidBalanceCents: 6000,
      expectedPrepaidBalanceCents: 2000,
    });
    expect(result).toEqual(token);
  });
});

describe('updateToken', () => {
  it('returns updated token when found', async () => {
    const token = { id: 't1', idToken: 'UPDATED', tokenType: 'ISO15693' };
    // current-row SELECT, dup check (empty), vehicle check (none), update returning
    setupDbResults([{ idToken: 'OLD', tokenType: 'ISO14443' }], [], [], [token]);

    const result = await updateToken('t1', { idToken: 'UPDATED', tokenType: 'ISO15693' });

    expect(result).toEqual(token);
  });

  it("refuses a vehicle that is not one of the card driver's vehicles", async () => {
    // current row (driver drv_1), the vehicle lookup for drv_1 (none)
    setupDbResults(
      [{ idToken: 'C', tokenType: 'ISO14443', driverId: 'drv_1', vehicleId: null, isActive: true }],
      [],
    );
    await expect(updateToken('t1', { vehicleId: 'veh_9' })).rejects.toThrow(
      "The vehicle is not one of the card driver's vehicles",
    );
  });

  it('pushes no tombstone from ISO14443 to ISO15693 (same OCPI Token, uid and RFID)', async () => {
    const token = { id: 't1', idToken: 'CARD', tokenType: 'ISO15693' };
    setupDbResults([{ idToken: 'CARD', tokenType: 'ISO14443' }], [], [token]);

    await updateToken('t1', { tokenType: 'ISO15693' });

    expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({ tokenIds: ['t1'], tombstones: [] });
  });

  it('tombstones the old value when the OCPI type changes', async () => {
    const token = { id: 't1', idToken: 'CARD', tokenType: 'eMAID' };
    setupDbResults([{ idToken: 'CARD', tokenType: 'ISO14443' }], [], [token]);

    await updateToken('t1', { tokenType: 'eMAID' });

    expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({
      tokenIds: ['t1'],
      tombstones: [{ idToken: 'CARD', tokenType: 'ISO14443' }],
    });
  });

  it('returns null when not found', async () => {
    // current-row SELECT empty, then update returning empty
    setupDbResults([], []);

    const result = await updateToken('nonexistent', { idToken: 'X' });

    expect(result).toBeNull();
  });

  it('throws DuplicateTokenError when rename would collide', async () => {
    setupDbResults([{ idToken: 'OLD', tokenType: 'ISO14443' }], [{ id: 'other' }]);

    await expect(
      updateToken('t1', { idToken: 'TAKEN', tokenType: 'ISO14443' }),
    ).rejects.toBeInstanceOf(DuplicateTokenError);
  });

  it('skips dup check when idToken/tokenType unchanged', async () => {
    const token = { id: 't1', idToken: 'OLD', tokenType: 'ISO14443', isActive: false };
    // select current, then update returning (no dup check because idToken/tokenType not in payload)
    setupDbResults([token], [token]);

    const result = await updateToken('t1', { isActive: false });

    expect(result).toEqual(token);
  });

  it('deactivates an active token, notifies the driver, and bumps stations holding it', async () => {
    const current = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: true,
    };
    const updated = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
    };
    // 1. select current
    // 2. update returning
    // 3. bumpStationsHoldingToken: select entries -> two rows on one station
    // 4. update stationLocalAuthVersions
    setupDbResults([current], [updated], [{ stationId: 'sta_1' }, { stationId: 'sta_1' }], []);

    const result = await updateToken(
      't1',
      { isActive: false, revokedReason: 'Lost card' },
      { type: 'operator', userId: 'usr_1' },
    );

    expect(result).toEqual(updated);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Deactivated',
      'drv_1',
      expect.objectContaining({ reason: 'Lost card' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });

  it('refuses a driver reactivating a token the operator deactivated', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'operator',
    };
    setupDbResults([current], [OWNER_ROW]);

    await expect(
      updateToken('t1', { isActive: true }, { type: 'driver', driverId: 'drv_1' }),
    ).rejects.toBeInstanceOf(TokenReactivationBlockedError);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('lets a driver reactivate a token the driver deactivated', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'driver',
    };
    const updated = { ...current, id: 't1', isActive: true, deactivatedBy: null };
    setupDbResults([current], [OWNER_ROW], [{ isActive: true }], [updated], []);

    const result = await updateToken(
      't1',
      { isActive: true },
      { type: 'driver', driverId: 'drv_1' },
    );

    expect(result).toEqual(updated);
  });

  it('refuses a driver update when the locked row belongs to another driver (PP-L1)', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_other',
      label: 'Old',
      isActive: true,
    };
    setupDbResults([current]);
    const result = await updateToken(
      't1',
      { label: 'Mine' },
      { type: 'driver', driverId: 'drv_1' },
    );
    expect(result).toBeNull();
    expect(databaseModule.db.update).not.toHaveBeenCalled();
  });

  it('refuses a driver label on an erased or inactive driver (PP-L1)', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      label: null,
      isActive: true,
    };
    for (const owner of [
      { isActive: false, erasedAt: new Date() },
      { isActive: false, erasedAt: null },
      null,
    ]) {
      vi.mocked(databaseModule.db.update).mockClear();
      setupDbResults([current], owner != null ? [owner] : []);
      const result = await updateToken(
        't1',
        { label: 'Anna' },
        { type: 'driver', driverId: 'drv_1' },
      );
      expect(result).toBeNull();
      expect(databaseModule.db.update).not.toHaveBeenCalled();
    }
  });

  it('maps a foreign key violation on driver_id to TokenDriverNotFoundError', async () => {
    const { db } = databaseModule;
    vi.mocked(db.transaction).mockRejectedValueOnce(
      Object.assign(new Error('fk'), { code: '23503' }),
    );

    await expect(
      updateToken('t1', { driverId: 'drv_missing' }, { type: 'operator', userId: 'usr_1' }),
    ).rejects.toBeInstanceOf(TokenDriverNotFoundError);
  });

  it('refuses reactivating a token of a deactivated driver', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
      deactivatedBy: 'operator',
    };
    setupDbResults([current], [{ isActive: false }]);

    await expect(
      updateToken('t1', { isActive: true }, { type: 'operator', userId: 'usr_1' }),
    ).rejects.toBeInstanceOf(TokenDriverInactiveError);
  });

  it('records an API key as the actor, not the user it acts for', async () => {
    const { writeAudit } = databaseModule;
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: null,
      isActive: true,
      deactivatedBy: null,
    };
    setupDbResults([current], [{ ...current, id: 't1', isActive: false }], []);

    await updateToken(
      't1',
      { isActive: false },
      { type: 'api_key', apiKeyId: 'key_1', userId: 'usr_1' },
    );

    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: 'api_key', actorApiKeyId: 'key_1', actorUserId: 'usr_1' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('reactivates an inactive token and clears the revoked stamp', async () => {
    const current = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
    };
    const updated = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: true,
    };
    // 1. select current
    // 2. update returning
    // 3. bumpStationsHoldingToken: select entries (empty)
    setupDbResults([current], [{ isActive: true }], [updated], []);

    const result = await updateToken(
      't1',
      { isActive: true },
      { type: 'operator', userId: 'usr_1' },
    );

    expect(result).toEqual(updated);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Reactivated',
      'drv_1',
      expect.objectContaining({ reactivatedBy: 'operator' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });

  it('swallows a driver-notification failure and still returns the updated token', async () => {
    const current = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: true,
    };
    const updated = {
      id: 't1',
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      isActive: false,
    };
    setupDbResults([current], [updated], []);
    vi.mocked(dispatchDriverNotification).mockRejectedValueOnce(new Error('SMTP down'));

    const result = await updateToken('t1', { isActive: false }, { type: 'system' });

    expect(result).toEqual(updated);
  });

  it('returns null when the update returns no row', async () => {
    const current = {
      id: 't1',
      idToken: 'OLD',
      tokenType: 'ISO14443',
      driverId: null,
      isActive: true,
    };
    setupDbResults([current], []);

    const result = await updateToken('t1', { expiresAt: new Date() });

    expect(result).toBeNull();
  });
});

describe('deleteToken', () => {
  it('returns deleted token when found', async () => {
    const token = { id: 't1', idToken: 'DELETED' };
    // 1. stations holding the token (none), 2. delete returning
    setupDbResults([], [token]);

    const result = await deleteToken('t1');

    expect(result).toEqual(token);
  });

  it('marks the local auth list of every station holding the token changed', async () => {
    const token = { id: 't1', idToken: 'DELETED', tokenType: 'ISO14443', driverId: null };
    // 1. stations holding the token, 2. delete returning, 3. version bump,
    // 4. station sites for the SSE event
    setupDbResults(
      [{ stationId: 'sta_1' }, { stationId: 'sta_1' }],
      [token],
      [],
      [{ id: 'sta_1', siteId: 'site_1' }],
    );

    await deleteToken('t1', { type: 'operator', userId: 'usr_1' });

    expect(databaseModule.db.update).toHaveBeenCalled();
  });

  it('returns null when not found', async () => {
    setupDbResults([], []);

    const result = await deleteToken('nonexistent');

    expect(result).toBeNull();
  });
});

describe('bulkSetActive', () => {
  it('returns updated 0 for an empty id list', async () => {
    const result = await bulkSetActive([], true);
    expect(result).toEqual({ updated: 0 });
  });

  it('returns updated 0 when the bulk update matches no rows', async () => {
    // update returning -> empty
    setupDbResults([]);

    const result = await bulkSetActive(['x', 'y'], false);

    expect(result).toEqual({ updated: 0 });
  });

  it('changes only tokens not already in the target state', async () => {
    const { ne } = await import('drizzle-orm');
    setupDbResults([]);

    await bulkSetActive(['t1'], false, { type: 'operator', userId: 'usr_1' });

    // The update is guarded by is_active <> target, so an already inactive
    // token keeps its revokedAt and gets no audit row or notification.
    expect(vi.mocked(ne)).toHaveBeenCalledWith('isActive', false);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('deactivates tokens, writes one audit batch, bumps stations, and notifies drivers', async () => {
    const updatedRows = [
      { id: 't1', idToken: 'A', tokenType: 'ISO14443', driverId: 'drv_1' },
      { id: 't2', idToken: 'B', tokenType: 'ISO14443', driverId: 'drv_2' },
    ];
    // 1. update returning -> two rows
    // 2. insert tokenAuditLog (no result)
    // 3. select entries -> one station
    // 4. update stationLocalAuthVersions
    setupDbResults(updatedRows, [], [{ stationId: 'sta_1' }], []);

    const result = await bulkSetActive(['t1', 't2'], false, { type: 'operator', userId: 'usr_1' });

    expect(result).toEqual({ updated: 2 });
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Deactivated',
      'drv_1',
      expect.objectContaining({ reason: '' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Deactivated',
      'drv_2',
      expect.objectContaining({ reason: '' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });

  it('reactivates tokens and notifies with the reactivated template', async () => {
    const updatedRows = [{ id: 't1', idToken: 'A', tokenType: 'ISO14443', driverId: 'drv_1' }];
    // 1. update returning
    // 2. insert audit
    // 3. select entries -> empty (no station bump)
    // no revoked contract token, no token of a deactivated driver, update
    // returning, audit, stations
    setupDbResults([], [], updatedRows, [], []);

    const result = await bulkSetActive(['t1'], true, { type: 'operator', userId: 'usr_1' });

    expect(result).toEqual({ updated: 1 });
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'token.Reactivated',
      'drv_1',
      expect.objectContaining({ reactivatedBy: 'operator' }),
      ALL_TEMPLATES_DIRS,
      expect.anything(),
    );
  });
});

describe('exportTokensCsv', () => {
  it('returns CSV string with header and data rows', async () => {
    const rows = [
      {
        idToken: 'TOK1',
        tokenType: 'ISO14443',
        driverEmail: 'a@b.com',
        isActive: true,
        expiresAt: null,
        label: 'Pool card, fleet 3',
      },
      {
        idToken: 'TOK2',
        tokenType: 'ISO15693',
        driverEmail: null,
        isActive: false,
        expiresAt: null,
      },
    ];
    setupDbResults(rows);

    const csv = await exportTokensCsv();

    const lines = csv.split('\n');
    expect(lines[0]).toBe('idToken,tokenType,driverEmail,isActive,expiresAt,label');
    expect(lines[1]).toBe('TOK1,ISO14443,a@b.com,true,,"Pool card, fleet 3"');
    expect(lines[2]).toBe('TOK2,ISO15693,,false,,');
  });

  it('serializes an expiresAt Date and applies the search filter', async () => {
    const expires = new Date('2027-01-01T00:00:00.000Z');
    setupDbResults([
      {
        idToken: 'TOK3',
        tokenType: 'ISO14443',
        driverEmail: 'c@d.com',
        isActive: true,
        expiresAt: expires,
      },
    ]);

    const csv = await exportTokensCsv({ search: 'TOK3', tokenType: 'ISO14443', status: 'active' });

    const lines = csv.split('\n');
    expect(lines[1]).toBe('TOK3,ISO14443,c@d.com,true,2027-01-01T00:00:00.000Z,');
  });
});

describe('token label', () => {
  it('trims a label and treats an empty one as no label', () => {
    expect(normalizeTokenLabel('  Pool card 3  ')).toBe('Pool card 3');
    expect(normalizeTokenLabel('   ')).toBeNull();
    expect(normalizeTokenLabel('')).toBeNull();
    expect(normalizeTokenLabel(null)).toBeNull();
    expect(normalizeTokenLabel(undefined)).toBeUndefined();
  });

  it('stores the trimmed label of a new token', async () => {
    const token = { id: 't1', idToken: 'NEW', tokenType: 'ISO14443', driverId: null, label: 'X' };
    setupDbResults([], [], [token]);

    await createToken({ idToken: 'NEW', tokenType: 'ISO14443', label: '  Spare card  ' });

    const insertChain = vi.mocked(databaseModule.db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Spare card' }),
    );
  });

  it('stores no label when none is sent', async () => {
    const token = { id: 't1', idToken: 'NEW', tokenType: 'ISO14443', driverId: null };
    setupDbResults([], [], [token]);

    await createToken({ idToken: 'NEW', tokenType: 'ISO14443' });

    const insertChain = vi.mocked(databaseModule.db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ label: null }));
  });

  it('audits a label change as an update without re-pushing station lists', async () => {
    const { writeAudit } = databaseModule;
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: null,
      label: 'Old',
      isActive: true,
      expiresAt: null,
      prepaidBalanceCents: null,
    };
    // current-row SELECT, update returning; no dup or vehicle check
    setupDbResults([current], [{ ...current, id: 't1', label: 'New' }]);

    await updateToken('t1', { label: ' New ' }, { type: 'operator', userId: 'usr_1' });

    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'updated',
        before: expect.objectContaining({ label: 'Old' }),
        after: expect.objectContaining({ label: 'New' }),
      }),
      expect.anything(),
      expect.anything(),
    );
    // Only the current-row SELECT and the update ran: no station list query.
    expect(dbCallIndex).toBe(2);
  });

  it('sends partners nothing for a change of the label alone', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      label: 'Old',
      isActive: true,
      expiresAt: null,
      revokedReason: null,
      prepaidBalanceCents: null,
      vehicleId: null,
    };
    setupDbResults([current], [OWNER_ROW], [{ ...current, id: 't1', label: 'New' }]);

    const result = await updateToken('t1', { label: 'New' }, { type: 'driver', driverId: 'drv_1' });

    expect(result).toMatchObject({ label: 'New' });
    expect(publishOcpiTokenPushMock).not.toHaveBeenCalled();
  });

  it('still pushes the token to partners when the label changes with another field', async () => {
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      label: 'Old',
      isActive: true,
      expiresAt: null,
      revokedReason: null,
      prepaidBalanceCents: null,
      vehicleId: null,
    };
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    setupDbResults([current], [{ ...current, id: 't1', label: 'New', expiresAt }]);

    await updateToken('t1', { label: 'New', expiresAt });

    expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({ tokenIds: ['t1'], tombstones: [] });
  });

  it.each([
    ['a line break', 'Pool\ncard'],
    ['a tab', 'Pool\tcard'],
    ['a C1 control', 'Pool\u0085card'],
    ['a right-to-left override', 'Pool\u202Ecard'],
    ['a bidi isolate', 'Pool\u2067card'],
    ['a right-to-left mark', 'Pool\u200Fcard'],
  ])('refuses a label with %s before any query', async (_name, label) => {
    setupDbResults();
    await expect(updateToken('t1', { label })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'label', problem: 'control_characters' },
    });
    await expect(
      createToken({ idToken: 'NEW', tokenType: 'ISO14443', label }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(dbCallIndex).toBe(0);
  });

  it('checks the length after trimming', async () => {
    const token = { id: 't1', idToken: 'NEW', tokenType: 'ISO14443', driverId: null };
    setupDbResults([], [], [token]);
    await createToken({ idToken: 'NEW', tokenType: 'ISO14443', label: `  ${'x'.repeat(100)}   ` });
    const insertChain = vi.mocked(databaseModule.db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'x'.repeat(100) }),
    );
    await expect(updateToken('t1', { label: 'x'.repeat(101) })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'label', problem: 'too_long' },
    });
  });

  describe('a token moved to another driver', () => {
    function captureUpdateSet(): { set: ReturnType<typeof vi.fn> } {
      const captured = { set: vi.fn() };
      vi.mocked(databaseModule.db.transaction).mockImplementationOnce((async (
        fn: (tx: unknown) => Promise<unknown>,
      ) => {
        const update = vi.fn(() => {
          const chain = makeChain();
          chain['set'] = vi.fn((values: unknown) => {
            captured.set(values);
            return chain;
          });
          return chain;
        });
        return fn({
          select: vi.fn(() => makeChain()),
          insert: vi.fn(() => makeChain()),
          update,
          delete: vi.fn(() => makeChain()),
        });
      }) as never);
      return captured;
    }
    const current = {
      idToken: 'RFID-1',
      tokenType: 'ISO14443',
      driverId: 'drv_1',
      label: 'Anna car',
      isActive: false,
      expiresAt: null,
      revokedReason: null,
      prepaidBalanceCents: null,
      vehicleId: null,
    };

    it('clears its label and notes it in the audit row', async () => {
      const { writeAudit } = databaseModule;
      const captured = captureUpdateSet();
      // current row, another driver's vehicle with the value (none), update returning
      setupDbResults([current], [], [{ ...current, id: 't1', driverId: 'drv_2', label: null }]);

      await updateToken('t1', { driverId: 'drv_2' }, { type: 'operator', userId: 'usr_1' });

      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'drv_2', label: null }),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'updated',
          before: expect.objectContaining({ label: 'Anna car', driverId: 'drv_1' }),
          after: expect.objectContaining({ label: null, driverId: 'drv_2' }),
          notes: 'Label cleared: the token moved to another driver',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('clears the label a full edit form sends back unchanged', async () => {
      const captured = captureUpdateSet();
      setupDbResults([current], [], [{ ...current, id: 't1', driverId: 'drv_2', label: null }]);

      await updateToken('t1', { driverId: 'drv_2', label: 'Anna car' });

      expect(captured.set).toHaveBeenCalledWith(expect.objectContaining({ label: null }));
    });

    it('keeps a new label the request sends with the move', async () => {
      const captured = captureUpdateSet();
      setupDbResults([current], [], [{ ...current, id: 't1', driverId: 'drv_2', label: 'Ben' }]);

      await updateToken('t1', { driverId: 'drv_2', label: ' Ben ' });

      expect(captured.set).toHaveBeenCalledWith(expect.objectContaining({ label: 'Ben' }));
    });

    it('keeps the label when the driver stays', async () => {
      const captured = captureUpdateSet();
      setupDbResults([current], [{ ...current, id: 't1', isActive: false }]);

      await updateToken('t1', { driverId: 'drv_1', isActive: false });

      expect(captured.set.mock.calls[0]?.[0]).not.toHaveProperty('label');
    });
  });

  it('clears the labels of a driver in the given transaction and writes no token audit row', async () => {
    const tx = { update: vi.fn(() => makeChain()) };
    setupDbResults([{ id: 't1' }, { id: 't2' }]);

    const cleared = await clearDriverTokenLabels(tx as never, 'drv_1');

    expect(cleared).toBe(2);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const chain = tx.update.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> };
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ label: null }));
    // An audit row here would carry the label in its before snapshot.
    expect(databaseModule.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses an imported label with a control character per row', async () => {
    setupDbResults([], [], [], []);
    const result = await importTokensCsv([
      { idToken: 'T2', tokenType: 'ISO14443', label: 'Pool\u202Ecard' },
    ]);
    expect(result.imported).toBe(0);
    expect(result.errors).toEqual(['Row 1: label contains control or invisible format characters']);
  });

  it('refuses a label with a zero-width character and keeps an emoji sequence (PP-I2)', () => {
    for (const label of [
      'Pool​card',
      'Pool‌card',
      'Pool‍card',
      'Pool⁠card',
      '﻿Pool card',
      'Pool­card',
      'Pool‮card',
      'Pool\ncard',
    ]) {
      expect(tokenLabelProblem(label), JSON.stringify(label)).toBe('control_characters');
    }
    for (const label of [
      'Family car \u{1F468}‍\u{1F469}‍\u{1F467}',
      'Dev \u{1F469}\u{1F3FD}‍\u{1F4BB}',
      'Rainbow \u{1F3F3}️‍\u{1F308}',
      'Plain café car',
    ]) {
      expect(tokenLabelProblem(label), label).toBeNull();
    }
  });

  it('imports a label and refuses one longer than 100 characters per row', async () => {
    const insertedRows = [
      { id: 't1', idToken: 'T1', tokenType: 'ISO14443', driverId: null, label: 'Pool 1' },
    ];
    // existing check (empty), vehicle ids (none), insert returning, audit insert
    setupDbResults([], [], insertedRows, []);

    const result = await importTokensCsv([
      { idToken: 'T1', tokenType: 'ISO14443', label: ' Pool 1 ' },
      { idToken: 'T2', tokenType: 'ISO14443', label: 'x'.repeat(101) },
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual(['Row 2: label is longer than 100 characters']);
  });
});

describe('importTokensCsv', () => {
  it('imports valid rows and returns count', async () => {
    // Inside the transaction:
    //  1. tx.select drivers by email (one row with email 'a@b.com')
    //  2. tx.select existing (idToken, tokenType) (empty)
    //  3. tx.insert(driverTokens).values(...).returning() (returns the 2 inserted rows)
    //  4. tx.insert(tokenAuditLog).values(...) (audit, no result needed)
    const driverRow = { id: 'driver-1', email: 'a@b.com', isActive: true };
    const insertedRows = [
      { id: 't1', idToken: 'T1', tokenType: 'ISO14443', driverId: 'driver-1' },
      { id: 't2', idToken: 'T2', tokenType: 'ISO15693', driverId: null },
    ];
    setupDbResults([driverRow], [], [], insertedRows, []);

    const result = await importTokensCsv([
      { idToken: 'T1', tokenType: 'ISO14443', driverEmail: 'a@b.com' },
      { idToken: 'T2', tokenType: 'ISO15693' },
    ]);

    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('returns errors for rows with missing fields', async () => {
    setupDbResults();

    const result = await importTokensCsv([
      { idToken: '', tokenType: 'ISO14443' },
      { idToken: 'T2', tokenType: '' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('Row 1');
    expect(result.errors[1]).toContain('Row 2');
  });

  it('returns error when driver email is not found', async () => {
    // Inside the transaction:
    //  1. tx.select drivers by email returns empty
    //  No rows are prepared (driver email unresolved), so existing check + inserts skipped
    setupDbResults([]);

    const result = await importTokensCsv([
      { idToken: 'T1', tokenType: 'ISO14443', driverEmail: 'unknown@example.com' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('driver not found');
    expect(result.errors[0]).toContain('unknown@example.com');
  });

  it('flags rows that collide with existing tokens', async () => {
    // No driverEmail provided, so driver lookup is skipped.
    // Inside the transaction:
    //  1. tx.select existing returns the conflicting token
    //  prepared has 1 row, but conflict means toInsert is empty -> no insert call
    setupDbResults([{ idToken: 'EXISTS', tokenType: 'ISO14443' }]);

    const result = await importTokensCsv([{ idToken: 'EXISTS', tokenType: 'ISO14443' }]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('already exists');
  });

  it('imports a row with a valid expiresAt date', async () => {
    const insertedRows = [{ id: 't1', idToken: 'EXP', tokenType: 'ISO14443', driverId: null }];
    // no driverEmail -> no driver lookup; existing (empty); insert returning; audit insert
    setupDbResults([], [], insertedRows, []);

    const result = await importTokensCsv([
      { idToken: 'EXP', tokenType: 'ISO14443', expiresAt: '2027-06-01T00:00:00Z' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('flags a row with an invalid expiresAt before the transaction', async () => {
    setupDbResults();

    const result = await importTokensCsv([
      { idToken: 'BAD', tokenType: 'ISO14443', expiresAt: 'not-a-date' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('invalid expiresAt');
  });

  it('returns empty result when every row fails parsing (no transaction)', async () => {
    setupDbResults();

    const result = await importTokensCsv([{ idToken: 'X1', tokenType: '' }]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('skips a blank line and reports an unknown token type or a bad email per row', async () => {
    setupDbResults();

    const result = await importTokensCsv([
      { idToken: '', tokenType: '' },
      { idToken: 'A1', tokenType: 'Bogus' },
      { idToken: 'A2', tokenType: 'ISO14443', driverEmail: 'not-an-email' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual(['Row 2: unknown tokenType Bogus', 'Row 3: invalid driverEmail']);
  });

  it('checks the driver email shape as the reference pattern, in linear time', () => {
    const reference = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const value of [
      'a@b.c',
      'a@.b.c',
      'a@b.',
      'a@.b',
      'a@b..c',
      '@b.c',
      'a@@b.c',
      'a@b.c@d',
      'a b@c.d',
      'a@b\t.c',
      'x.y@z',
    ]) {
      expect(hasEmailShape(value), value).toBe(reference.test(value));
    }
    const alphabet = ['a', '.', '@', ' ', '!'];
    let seed = 5;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 20_000; n++) {
      let value = '';
      const length = next() % 10;
      for (let k = 0; k < length; k++) value += alphabet[next() % alphabet.length] ?? '';
      expect(hasEmailShape(value), JSON.stringify(value)).toBe(reference.test(value));
    }
    const started = performance.now();
    expect(hasEmailShape(`!@!.${'!.'.repeat(100_000)}@`)).toBe(false);
    expect(hasEmailShape(`a@${'b.'.repeat(100_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('treats a blank expiresAt string as no expiry', async () => {
    const insertedRows = [{ id: 't1', idToken: 'BLANK', tokenType: 'ISO14443', driverId: null }];
    setupDbResults([], [], insertedRows, []);

    const result = await importTokensCsv([
      { idToken: 'BLANK', tokenType: 'ISO14443', expiresAt: '   ' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('flags duplicate rows within the same batch', async () => {
    // The second DUPE row is caught by seenInBatch BEFORE the transaction, so
    // only 1 row enters the transaction. No driverEmail -> no driver lookup.
    //  1. tx.select existing (empty)
    //  2. tx.insert returning -> 1 inserted row
    //  3. tx.insert audit
    const insertedRows = [{ id: 't1', idToken: 'DUPE', tokenType: 'ISO14443', driverId: null }];
    setupDbResults([], [], insertedRows, []);

    const result = await importTokensCsv([
      { idToken: 'DUPE', tokenType: 'ISO14443' },
      { idToken: 'DUPE', tokenType: 'ISO14443' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Row 2');
    expect(result.errors[0]).toContain('duplicate');
  });
});

describe('tokenActorOf', () => {
  it('maps a request actor to the token actor', () => {
    const base = { actorUserId: null, actorDriverId: null, actorApiKeyId: null, actorLabel: null };
    expect(tokenActorOf({ ...base, actor: 'operator', actorUserId: 'usr_1' })).toEqual({
      type: 'operator',
      userId: 'usr_1',
    });
    expect(
      tokenActorOf({ ...base, actor: 'api_key', actorUserId: 'usr_1', actorApiKeyId: 'key_1' }),
    ).toEqual({ type: 'api_key', apiKeyId: 'key_1', userId: 'usr_1' });
    expect(tokenActorOf({ ...base, actor: 'driver', actorDriverId: 'drv_1' })).toEqual({
      type: 'driver',
      driverId: 'drv_1',
    });
    expect(tokenActorOf({ ...base, actor: 'system' })).toEqual({ type: 'system' });
  });
});

describe('bulkSetActive with a deactivated driver', () => {
  it('refuses activation when a token belongs to a deactivated driver', async () => {
    setupDbResults([], [{ driverId: 'drv_off' }]);
    await expect(bulkSetActive(['t1'], true)).rejects.toBeInstanceOf(TokenDriverInactiveError);
  });
});

describe('Plug and Charge contract tokens', () => {
  const emaid = {
    id: 't9',
    idToken: 'USEVTC12345678',
    tokenType: 'eMAID',
    driverId: 'drv_1',
    isActive: false,
    deactivatedBy: 'operator',
  };

  it('refuses to reactivate the eMAID of a revoked contract', async () => {
    setupDbResults([emaid], [{ tokenId: 't9', status: 'revoked' }]);
    await expect(updateToken('t9', { isActive: true })).rejects.toMatchObject({
      name: 'PncContractTokenError',
      reason: 'contract_revoked',
    });
  });

  it.each([
    ['value', { idToken: 'USEVTC00000000' }],
    ['type', { tokenType: 'ISO14443' }],
    ['driver', { driverId: 'drv_2' }],
  ])('refuses to change the %s of a contract eMAID', async (_label, data) => {
    setupDbResults([{ ...emaid, isActive: true }], [{ tokenId: 't9', status: 'active' }]);
    await expect(updateToken('t9', data)).rejects.toBeInstanceOf(PncContractTokenError);
  });

  it('refuses to delete the eMAID of an active contract', async () => {
    // stations holding it, delete matches nothing, the contract lookup finds
    // the active contract
    setupDbResults([], [], [{ tokenId: 't9', status: 'active' }]);
    await expect(deleteToken('t9')).rejects.toMatchObject({ reason: 'contract_active' });
  });

  it('refuses a bulk activation that holds the eMAID of a revoked contract', async () => {
    setupDbResults([{ tokenId: 't9', status: 'revoked' }]);
    await expect(bulkSetActive(['t1', 't9'], true)).rejects.toBeInstanceOf(PncContractTokenError);
  });
});

describe('driver RFID self-service off (portal.rfidSelfServiceEnabled)', () => {
  const driver = { type: 'driver' as const, driverId: 'drv_1' };

  beforeEach(() => {
    vi.mocked(databaseModule.isDriverRfidSelfServiceEnabled).mockResolvedValue(false);
  });

  it('refuses a driver create, a re-add included, before any query', async () => {
    await expect(
      createToken({ idToken: 'NEW1', tokenType: 'ISO14443', driverId: 'drv_1' }, driver),
    ).rejects.toBeInstanceOf(RfidSelfServiceDisabledError);
    expect(databaseModule.db.select).not.toHaveBeenCalled();
    expect(databaseModule.db.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['a rename', { label: 'Work' }],
    ['a reactivation', { isActive: true }],
    ['a deactivation', { isActive: false }],
    ['a removal', { isActive: false, revokedReason: 'Removed by driver' }],
    ['an id change', { idToken: 'X1' }],
    ['a type change', { tokenType: 'KeyCode' }],
    ['a driver change', { driverId: 'drv_2' }],
    ['an expiry change', { expiresAt: null }],
  ])('refuses %s by a driver before the transaction', async (_name, change) => {
    await expect(updateToken('t1', change, driver)).rejects.toBeInstanceOf(
      RfidSelfServiceDisabledError,
    );
    expect(databaseModule.db.transaction).not.toHaveBeenCalled();
    expect(databaseModule.db.select).not.toHaveBeenCalled();
  });

  it('never reads the setting for an operator, an API key or the system', async () => {
    const token = { id: 't1', idToken: 'OPS1', tokenType: 'ISO14443', driverId: null };
    for (const actor of [
      { type: 'operator' as const, userId: 'usr_1' },
      { type: 'api_key' as const, userId: 'usr_1', apiKeyId: 'key_1' },
      { type: 'system' as const },
    ]) {
      setupDbResults([], [], [token]);
      await expect(createToken({ idToken: 'OPS1', tokenType: 'ISO14443' }, actor)).resolves.toEqual(
        token,
      );
    }
    expect(databaseModule.isDriverRfidSelfServiceEnabled).not.toHaveBeenCalled();
  });

  it('lets a driver write pass the setting check once it is on', async () => {
    vi.mocked(databaseModule.isDriverRfidSelfServiceEnabled).mockResolvedValue(true);
    // No duplicate, no vehicle hit, no driver row: the write goes past the
    // setting check to the driver lookup.
    setupDbResults([], [], []);
    await expect(
      createToken({ idToken: 'NEW2', tokenType: 'ISO14443', driverId: 'drv_1' }, driver),
    ).rejects.toBeInstanceOf(TokenDriverNotFoundError);
    expect(databaseModule.db.select).toHaveBeenCalled();
  });
});

describe('fleet RFID cards', () => {
  const operator = { type: 'operator' as const, userId: 'usr_1' };
  const fleetUserScope = { fleet: { fleetId: 'flt_1', byFleetUser: true } };
  const operatorScope = { fleet: { fleetId: 'flt_1', byFleetUser: false } };

  function captureTx(): { set: ReturnType<typeof vi.fn>; values: ReturnType<typeof vi.fn> } {
    const captured = { set: vi.fn(), values: vi.fn() };
    vi.mocked(databaseModule.db.transaction).mockImplementationOnce((async (
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      const update = vi.fn(() => {
        const chain = makeChain();
        chain['set'] = vi.fn((v: unknown) => {
          captured.set(v);
          return chain;
        });
        return chain;
      });
      const insert = vi.fn(() => {
        const chain = makeChain();
        chain['values'] = vi.fn((v: unknown) => {
          captured.values(v);
          return chain;
        });
        return chain;
      });
      return fn({
        select: vi.fn(() => makeChain()),
        insert,
        update,
        delete: vi.fn(() => makeChain()),
      });
    }) as never);
    return captured;
  }

  const card = {
    idToken: 'CARD-1',
    tokenType: 'ISO14443',
    driverId: null,
    label: 'Van 12',
    isActive: true,
    expiresAt: null,
    revokedReason: null,
    deactivatedBy: null,
    prepaidBalanceCents: null,
    vehicleId: null,
    fleetId: 'flt_1',
    revokedAt: null,
  };

  describe('without fleetCards:write', () => {
    const noPermission = { fleetCardsWrite: false };

    it('refuses a fleet or a monthly limit on create before any read', async () => {
      await expect(
        createToken(
          { idToken: 'CARD-9', tokenType: 'ISO14443', fleetId: 'flt_1' },
          operator,
          noPermission,
        ),
      ).rejects.toBeInstanceOf(FleetCardPermissionError);
      await expect(
        createToken(
          { idToken: 'CARD-9', tokenType: 'ISO14443', monthlyLimitCents: 100 },
          operator,
          noPermission,
        ),
      ).rejects.toBeInstanceOf(FleetCardPermissionError);
      expect(databaseModule.db.select).not.toHaveBeenCalled();
    });

    it('refuses any change of a fleet card and a move into a fleet, decided on the locked row', async () => {
      setupDbResults([{ ...card }]);
      await expect(
        updateToken('dtk_1', { label: 'Renamed' }, operator, noPermission),
      ).rejects.toBeInstanceOf(FleetCardPermissionError);
      setupDbResults([{ ...card, fleetId: null }]);
      await expect(
        updateToken('dtk_1', { fleetId: 'flt_1' }, operator, noPermission),
      ).rejects.toBeInstanceOf(FleetCardPermissionError);
    });

    it('refuses deleting or bulk toggling a fleet card before any write', async () => {
      setupDbResults([{ id: 'dtk_1' }]);
      await expect(deleteToken('dtk_1', operator, noPermission)).rejects.toBeInstanceOf(
        FleetCardPermissionError,
      );
      setupDbResults([{ id: 'dtk_1' }]);
      await expect(
        bulkSetActive(['dtk_1', 'dtk_2'], false, operator, noPermission),
      ).rejects.toBeInstanceOf(FleetCardPermissionError);
      expect(databaseModule.db.delete).not.toHaveBeenCalled();
      expect(databaseModule.db.update).not.toHaveBeenCalled();
    });
  });

  describe('site-restricted operators', () => {
    it('refuses a fleet card create, update and fleet move, before any read', async () => {
      siteScope.allSites = false;
      await expect(
        createToken({ idToken: 'CARD-9', tokenType: 'ISO14443', fleetId: 'flt_1' }, operator),
      ).rejects.toBeInstanceOf(FleetCardSiteScopeError);
      await expect(
        updateToken('dtk_1', { label: 'Van 9' }, operator, operatorScope),
      ).rejects.toBeInstanceOf(FleetCardSiteScopeError);
      expect(databaseModule.db.select).not.toHaveBeenCalled();
      expect(databaseModule.db.transaction).not.toHaveBeenCalled();
    });

    it('refuses any change of a fleet card, decided on the locked row', async () => {
      siteScope.allSites = false;
      setupDbResults([{ ...card }]);
      await expect(updateToken('dtk_1', { label: 'Renamed' }, operator)).rejects.toBeInstanceOf(
        FleetCardSiteScopeError,
      );
    });

    it('refuses deleting or bulk toggling a fleet card before any write', async () => {
      siteScope.allSites = false;
      setupDbResults([{ id: 'dtk_1' }]);
      await expect(deleteToken('dtk_1', operator)).rejects.toBeInstanceOf(FleetCardSiteScopeError);
      setupDbResults([{ id: 'dtk_1' }]);
      await expect(bulkSetActive(['dtk_1', 'dtk_2'], false, operator)).rejects.toBeInstanceOf(
        FleetCardSiteScopeError,
      );
      expect(databaseModule.db.delete).not.toHaveBeenCalled();
      expect(databaseModule.db.update).not.toHaveBeenCalled();
    });

    it('refuses moving a card out of its fleet, decided on the locked row', async () => {
      siteScope.allSites = false;
      setupDbResults([{ ...card }]);
      await expect(updateToken('dtk_1', { fleetId: null }, operator)).rejects.toBeInstanceOf(
        FleetCardSiteScopeError,
      );
    });

    it("lets a fleet user's own scope through", async () => {
      siteScope.allSites = false;
      siteScope.fleetUser = true;
      const outcome = await createToken(
        { idToken: 'CARD-9', tokenType: 'ISO14443', fleetId: 'flt_1' },
        operator,
        fleetUserScope,
      ).catch((err: unknown) => err);
      expect(outcome).not.toBeInstanceOf(FleetCardSiteScopeError);
    });
  });

  describe('createToken', () => {
    it('refuses a driver adding a card to a fleet', async () => {
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', driverId: 'drv_1', fleetId: 'flt_1' },
          { type: 'driver', driverId: 'drv_1' },
        ),
      ).rejects.toBeInstanceOf(TokenManagedByFleetError);
      expect(databaseModule.db.select).not.toHaveBeenCalled();
    });

    it('holds a fleet user to the vehicle id shape rule of drivers', async () => {
      await expect(
        createToken(
          { idToken: '00:1A:2B:3C:4D:5E', tokenType: 'ISO14443' },
          operator,
          fleetUserScope,
        ),
      ).rejects.toBeInstanceOf(VehicleShapedCardError);
    });

    it('refuses an unknown fleet', async () => {
      // existing card, vehicle id collision, fleet FOR SHARE
      setupDbResults([], [], []);
      captureTx();
      await expect(
        createToken({ idToken: 'CARD-1', tokenType: 'ISO14443', fleetId: 'flt_x' }, operator),
      ).rejects.toBeInstanceOf(TokenFleetNotFoundError);
    });

    it('refuses giving a card to a driver who is not a member of the fleet', async () => {
      // existing, collision, fleet, driver, membership (none)
      setupDbResults([], [], [FLEET_ROW], [OWNER_ROW], []);
      captureTx();
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', driverId: 'drv_2' },
          operator,
          operatorScope,
        ),
      ).rejects.toBeInstanceOf(FleetCardDriverNotMemberError);
    });

    it('refuses a fleet card while the fleet does not bill on account, before the member check', async () => {
      setupDbResults([], [], [{ ...FLEET_ROW, accountBillingEnabled: false }]);
      captureTx();
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', driverId: 'drv_2' },
          operator,
          operatorScope,
        ),
      ).rejects.toBeInstanceOf(FleetCardNotBillableError);
    });

    it('refuses a fleet card while Fleets is off', async () => {
      vi.mocked(isFleetEnabled).mockResolvedValueOnce(false);
      setupDbResults([], [], [FLEET_ROW]);
      captureTx();
      await expect(
        createToken({ idToken: 'CARD-1', tokenType: 'ISO14443' }, operator, operatorScope),
      ).rejects.toBeInstanceOf(FleetCardNotBillableError);
    });

    it('refuses an inactive or erased driver as not a member', async () => {
      setupDbResults([], [], [FLEET_ROW], [{ isActive: false, erasedAt: null }]);
      captureTx();
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', driverId: 'drv_2' },
          operator,
          operatorScope,
        ),
      ).rejects.toBeInstanceOf(FleetCardDriverNotMemberError);
    });

    it('stores the fleet of a card given to a member and audits it', async () => {
      const inserted = { ...card, id: 'dtk_1', driverId: 'drv_2' };
      setupDbResults([], [], [FLEET_ROW], [OWNER_ROW], [{ id: 1 }], [inserted]);
      const captured = captureTx();
      await createToken(
        { idToken: 'CARD-1', tokenType: 'ISO14443', driverId: 'drv_2', label: 'Van 12' },
        operator,
        fleetUserScope,
      );
      expect(captured.values).toHaveBeenCalledWith(
        expect.objectContaining({ fleetId: 'flt_1', driverId: 'drv_2', label: 'Van 12' }),
      );
      expect(databaseModule.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'created',
          after: expect.objectContaining({ fleetId: 'flt_1' }),
        }),
        expect.anything(),
        expect.anything(),
      );
      // A card a member holds reaches roaming partners like the member's own cards.
      expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({ tokenIds: ['dtk_1'] });
    });

    it('sends a fleet card no member holds to no roaming partner', async () => {
      const inserted = { ...card, id: 'dtk_1', driverId: null };
      setupDbResults([], [], [FLEET_ROW], [inserted]);
      captureTx();
      await createToken({ idToken: 'CARD-1', tokenType: 'ISO14443' }, operator, fleetUserScope);
      expect(publishOcpiTokenPushMock).not.toHaveBeenCalled();
    });

    it('refuses a monthly limit without a fleet or out of range before any write', async () => {
      await expect(
        createToken({ idToken: 'CARD-1', tokenType: 'ISO14443', monthlyLimitCents: 500 }, operator),
      ).rejects.toMatchObject({ details: { field: 'monthlyLimitCents' } });
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', monthlyLimitCents: 0 },
          operator,
          fleetUserScope,
        ),
      ).rejects.toMatchObject({ details: { field: 'monthlyLimitCents' } });
      expect(databaseModule.db.transaction).not.toHaveBeenCalled();
    });

    it('refuses a prepaid balance on a fleet card before any write', async () => {
      await expect(
        createToken(
          { idToken: 'CARD-1', tokenType: 'ISO14443', prepaidBalanceCents: 500 },
          operator,
          fleetUserScope,
        ),
      ).rejects.toMatchObject({ details: { field: 'prepaidBalanceCents' } });
      expect(databaseModule.db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateToken', () => {
    it('refuses to move a prepaid card into a fleet, and a balance on a fleet card', async () => {
      setupDbResults([{ ...card, fleetId: null, prepaidBalanceCents: 500 }]);
      await expect(updateToken('dtk_1', { fleetId: 'flt_1' }, operator)).rejects.toMatchObject({
        details: { field: 'prepaidBalanceCents' },
      });

      setupDbResults([{ ...card, prepaidBalanceCents: null }]);
      await expect(
        updateToken(
          'dtk_1',
          { prepaidBalanceCents: 500, expectedPrepaidBalanceCents: null },
          operator,
        ),
      ).rejects.toMatchObject({ details: { field: 'prepaidBalanceCents' } });
    });

    it('refuses every driver write of a fleet card', async () => {
      setupDbResults([{ ...card, driverId: 'drv_1' }], [OWNER_ROW]);
      await expect(
        updateToken('dtk_1', { label: 'Mine' }, { type: 'driver', driverId: 'drv_1' }),
      ).rejects.toBeInstanceOf(TokenManagedByFleetError);
    });

    it('answers not found for a card of another fleet through the fleet routes', async () => {
      setupDbResults([{ ...card, fleetId: 'flt_2' }]);
      expect(await updateToken('dtk_1', { label: 'X' }, operator, fleetUserScope)).toBeNull();
    });

    it('takes only the label, status and member through the fleet routes', async () => {
      await expect(
        updateToken('dtk_1', { idToken: 'OTHER' }, operator, fleetUserScope),
      ).rejects.toThrow('label, status, member and monthly limit only');
      await expect(
        updateToken('dtk_1', { fleetId: null }, operator, fleetUserScope),
      ).rejects.toThrow('label, status, member and monthly limit only');
    });

    it('never lets a fleet user lift an operator block or bring back a revoked card', async () => {
      setupDbResults([{ ...card, isActive: false, deactivatedBy: 'operator' }]);
      await expect(
        updateToken('dtk_1', { isActive: true }, operator, fleetUserScope),
      ).rejects.toBeInstanceOf(TokenReactivationBlockedError);

      setupDbResults([{ ...card, isActive: false, deactivatedBy: 'fleet', revokedAt: new Date() }]);
      await expect(
        updateToken('dtk_1', { isActive: true }, operator, operatorScope),
      ).rejects.toBeInstanceOf(FleetCardDeactivatedError);

      setupDbResults([{ ...card, isActive: false, deactivatedBy: 'fleet', revokedAt: new Date() }]);
      await expect(
        updateToken('dtk_1', { isActive: true }, operator, fleetUserScope),
      ).rejects.toBeInstanceOf(FleetCardDeactivatedError);
    });

    it('answers an operator block before the deactivation to a fleet user', async () => {
      setupDbResults([
        { ...card, isActive: false, deactivatedBy: 'operator', revokedAt: new Date() },
      ]);
      await expect(
        updateToken('dtk_1', { isActive: true }, operator, fleetUserScope),
      ).rejects.toBeInstanceOf(TokenReactivationBlockedError);
    });

    it('lets a fleet user turn on a card taken back from a member', async () => {
      const captured = captureTx();
      setupDbResults(
        [
          {
            ...card,
            isActive: false,
            deactivatedBy: 'system',
            revokedReason: FLEET_CARD_RELEASE_REASON,
          },
        ],
        [{ ...card, id: 'dtk_1' }],
      );
      await updateToken('dtk_1', { isActive: true }, operator, fleetUserScope);
      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true, deactivatedBy: null, revokedAt: null }),
      );
    });

    it('sets the monthly limit of a fleet card through the fleet routes', async () => {
      const captured = captureTx();
      setupDbResults([card], [{ ...card, id: 'dtk_1', monthlyLimitCents: 5_000 }]);
      await updateToken('dtk_1', { monthlyLimitCents: 5_000 }, operator, fleetUserScope);
      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ monthlyLimitCents: 5_000 }),
      );
    });

    it('drops the monthly limit of a card moved out of its fleet', async () => {
      const captured = captureTx();
      setupDbResults(
        [{ ...card, monthlyLimitCents: 5_000 }],
        [{ ...card, id: 'dtk_1', fleetId: null, monthlyLimitCents: null }],
      );
      await updateToken('dtk_1', { fleetId: null }, operator);
      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ fleetId: null, monthlyLimitCents: null }),
      );
    });

    it('refuses a monthly limit on a card without a fleet', async () => {
      setupDbResults([{ ...card, fleetId: null }]);
      await expect(
        updateToken('dtk_1', { monthlyLimitCents: 5_000 }, operator),
      ).rejects.toMatchObject({ details: { field: 'monthlyLimitCents' } });
    });

    it('suspends without a revocation when a fleet user turns a card off', async () => {
      const captured = captureTx();
      setupDbResults([card], [{ ...card, id: 'dtk_1', isActive: false }]);
      await updateToken('dtk_1', { isActive: false }, operator, fleetUserScope);
      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false, deactivatedBy: 'fleet', revokedAt: null }),
      );
    });

    it('revokes a card an operator suspended on the fleet delete and audits it as revoked', async () => {
      const captured = captureTx();
      const suspended = { ...card, isActive: false, deactivatedBy: 'fleet' };
      setupDbResults(
        [suspended],
        [
          {
            ...suspended,
            id: 'dtk_1',
            revokedAt: new Date(),
            revokedReason: 'Deactivated by an operator',
          },
        ],
      );
      await updateToken(
        'dtk_1',
        { isActive: false, revokedReason: 'Deactivated by an operator' },
        operator,
        { fleet: { fleetId: 'flt_1', byFleetUser: false, revoke: true } },
      );
      expect(captured.set).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date), deactivatedBy: 'operator' }),
      );
      expect(databaseModule.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'revoked', notes: 'Deactivated by an operator' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('refuses a fleet user the fleet delete before any read', async () => {
      await expect(
        updateToken('dtk_1', { isActive: false }, operator, {
          fleet: { fleetId: 'flt_1', byFleetUser: true, revoke: true },
        }),
      ).rejects.toBeInstanceOf(FleetCardRevokeRefusedError);
      expect(databaseModule.writeAudit).not.toHaveBeenCalled();
    });

    it('keeps the label when a fleet card moves to another member', async () => {
      const captured = captureTx();
      // current, fleet billing, fleet member check (driver, membership), active driver, collision, update
      setupDbResults(
        [{ ...card, driverId: 'drv_1' }],
        [FLEET_ROW],
        [OWNER_ROW],
        [{ id: 1 }],
        [{ isActive: true }],
        [],
        [{ ...card, id: 'dtk_1', driverId: 'drv_2' }],
      );
      await updateToken('dtk_1', { driverId: 'drv_2' }, operator, fleetUserScope);
      const values = captured.set.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(values['driverId']).toBe('drv_2');
      expect(values).not.toHaveProperty('label');
      // Fleet card notices, never the plain card added or removed notices.
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'token.FleetCardAssigned',
        'drv_2',
        expect.objectContaining({ idToken: card.idToken, fleetName: expect.any(String) }),
        expect.anything(),
        expect.anything(),
      );
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'token.FleetCardTakenBack',
        'drv_1',
        expect.objectContaining({ idToken: card.idToken }),
        expect.anything(),
        expect.anything(),
      );
      const events = vi.mocked(dispatchDriverNotification).mock.calls.map((c) => c[1]);
      expect(events).not.toContain('token.Added');
      expect(events).not.toContain('token.Removed');
    });

    it('refuses giving a fleet card to a member while the fleet does not bill on account', async () => {
      captureTx();
      setupDbResults(
        [{ ...card, driverId: null }],
        [{ ...FLEET_ROW, accountBillingEnabled: false }],
      );
      await expect(
        updateToken('dtk_1', { driverId: 'drv_2' }, operator, fleetUserScope),
      ).rejects.toBeInstanceOf(FleetCardNotBillableError);
    });

    it('lets a fleet card be taken back while the fleet does not bill on account', async () => {
      captureTx();
      setupDbResults(
        [{ ...card, driverId: 'drv_1' }],
        [],
        [{ ...card, id: 'dtk_1', driverId: null }],
      );
      await expect(
        updateToken('dtk_1', { driverId: null }, operator, fleetUserScope),
      ).resolves.not.toBeNull();
    });

    it('refuses an operator moving a card into a fleet the driver is not a member of', async () => {
      captureTx();
      setupDbResults([{ ...card, fleetId: null, driverId: 'drv_1' }], [FLEET_ROW], [OWNER_ROW], []);
      await expect(updateToken('dtk_1', { fleetId: 'flt_1' }, operator)).rejects.toBeInstanceOf(
        FleetCardDriverNotMemberError,
      );
    });
  });

  describe('releaseMemberFleetCards', () => {
    it('takes the cards back in the caller transaction and runs the side effects after it', async () => {
      const set = vi.fn();
      const tx = {
        update: vi.fn(() => {
          const chain = makeChain();
          chain['set'] = vi.fn((v: unknown) => {
            set(v);
            return chain;
          });
          return chain;
        }),
      };
      setupDbResults([
        {
          id: 'dtk_1',
          idToken: 'CARD-1',
          tokenType: 'ISO14443',
          label: 'Van 12',
          fleetId: 'flt_1',
        },
      ]);
      const result = await releaseMemberFleetCards(
        { driverId: 'drv_1', fleetId: 'flt_1' },
        operator,
        tx as never,
      );
      expect(result.released).toBe(1);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: null, vehicleId: null, isActive: false }),
      );
      expect(databaseModule.writeAudit).not.toHaveBeenCalled();
      expect(publishOcpiTokenPushMock).not.toHaveBeenCalled();

      await result.afterCommit();
      expect(databaseModule.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'updated',
          notes: FLEET_CARD_RELEASE_REASON,
          before: expect.objectContaining({ driverId: 'drv_1', label: 'Van 12' }),
          after: expect.objectContaining({ driverId: null, label: 'Van 12', fleetId: 'flt_1' }),
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({ tokenIds: ['dtk_1'] });
      // The member hears each card taken back.
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'token.FleetCardTakenBack',
        'drv_1',
        expect.objectContaining({ idToken: 'CARD-1', tokenType: 'ISO14443', label: 'Van 12' }),
        ALL_TEMPLATES_DIRS,
        expect.anything(),
      );
    });

    it('takes the cards back even when the notice fails', async () => {
      vi.mocked(dispatchDriverNotification).mockRejectedValueOnce(new Error('SMTP down'));
      setupDbResults([
        { id: 'dtk_1', idToken: 'CARD-1', tokenType: 'ISO14443', label: null, fleetId: 'flt_1' },
      ]);
      const result = await releaseMemberFleetCards({ driverId: 'drv_1' });
      expect(result.released).toBe(1);
      expect(publishOcpiTokenPushMock).toHaveBeenCalledWith({ tokenIds: ['dtk_1'] });
    });

    it('runs the side effects itself without a transaction and writes nothing for no card', async () => {
      setupDbResults([]);
      const result = await releaseMemberFleetCards({ driverId: 'drv_1' });
      expect(result.released).toBe(0);
      expect(databaseModule.writeAudit).not.toHaveBeenCalled();
      expect(publishOcpiTokenPushMock).not.toHaveBeenCalled();
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    });
  });

  describe('markFleetCardListsChanged', () => {
    it('marks the lists holding the unassigned cards of the fleet', async () => {
      // unassigned cards, stations holding them, station sites (publish)
      setupDbResults(
        [{ id: 'dtk_1' }],
        [{ stationId: 'sta_1' }],
        [],
        [{ id: 'sta_1', siteId: 'sit_1' }],
      );
      await markFleetCardListsChanged('flt_1');
      expect(databaseModule.db.update).toHaveBeenCalled();
    });

    it('logs and goes on when the read fails', async () => {
      vi.mocked(databaseModule.db.select).mockImplementationOnce(() => {
        throw new Error('db down');
      });
      await expect(markFleetCardListsChanged('flt_1')).resolves.toBeUndefined();
    });
  });
});
