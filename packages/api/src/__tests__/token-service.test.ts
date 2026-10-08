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

vi.mock('@evtivity/database', async () => ({
  // The real SQLSTATE readers, so the mocked errors map as in production.
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
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

import {
  listTokens,
  getToken,
  createToken,
  updateToken,
  deleteToken,
  bulkSetActive,
  exportTokensCsv,
  importTokensCsv,
  DuplicateTokenError,
} from '../services/token.service.js';
import { dispatchDriverNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import * as databaseModule from '@evtivity/database';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
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

describe('createToken', () => {
  it('returns created token', async () => {
    const token = { id: 't1', idToken: 'NEW_TOKEN', tokenType: 'ISO14443', driverId: null };
    // dup check (empty), insert returning, writeAudit insert (no result needed),
    // publishTokenChanged is async pubsub call (no DB)
    setupDbResults([], [token]);

    const result = await createToken({ idToken: 'NEW_TOKEN', tokenType: 'ISO14443' });

    expect(result).toEqual(token);
  });

  it('throws DuplicateTokenError when (idToken, tokenType) already exists', async () => {
    setupDbResults([{ id: 'existing' }]);

    await expect(
      createToken({ idToken: 'NEW_TOKEN', tokenType: 'ISO14443' }),
    ).rejects.toBeInstanceOf(DuplicateTokenError);
  });

  it('allows the same idToken under a different tokenType', async () => {
    const token = { id: 't2', idToken: 'SAME_UID', tokenType: 'ISO15693', driverId: null };
    // dup check on (SAME_UID, ISO15693) returns empty, then insert returning
    setupDbResults([], [token]);

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
    setupDbResults([], [token]);

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
    };
    setupDbResults([existing], [currentRow], [reactivated], []);

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

describe('updateToken', () => {
  it('returns updated token when found', async () => {
    const token = { id: 't1', idToken: 'UPDATED', tokenType: 'ISO15693' };
    // current-row SELECT, dup check (empty), update returning
    setupDbResults([{ idToken: 'OLD', tokenType: 'ISO14443' }], [], [token]);

    const result = await updateToken('t1', { idToken: 'UPDATED', tokenType: 'ISO15693' });

    expect(result).toEqual(token);
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
    setupDbResults([current], [updated], []);

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
    setupDbResults([token]);

    const result = await deleteToken('t1');

    expect(result).toEqual(token);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

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
    setupDbResults(updatedRows, [], []);

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
    expect(lines[0]).toBe('idToken,tokenType,driverEmail,isActive,expiresAt');
    expect(lines[1]).toBe('TOK1,ISO14443,a@b.com,true,');
    expect(lines[2]).toBe('TOK2,ISO15693,,false,');
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

    const csv = await exportTokensCsv('TOK3');

    const lines = csv.split('\n');
    expect(lines[1]).toBe('TOK3,ISO14443,c@d.com,true,2027-01-01T00:00:00.000Z');
  });
});

describe('importTokensCsv', () => {
  it('imports valid rows and returns count', async () => {
    // Inside the transaction:
    //  1. tx.select drivers by email (one row with email 'a@b.com')
    //  2. tx.select existing (idToken, tokenType) (empty)
    //  3. tx.insert(driverTokens).values(...).returning() (returns the 2 inserted rows)
    //  4. tx.insert(tokenAuditLog).values(...) (audit, no result needed)
    const driverRow = { id: 'driver-1', email: 'a@b.com' };
    const insertedRows = [
      { id: 't1', idToken: 'T1', tokenType: 'ISO14443', driverId: 'driver-1' },
      { id: 't2', idToken: 'T2', tokenType: 'ISO15693', driverId: null },
    ];
    setupDbResults([driverRow], [], insertedRows, []);

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
    setupDbResults([], insertedRows, []);

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

    const result = await importTokensCsv([{ idToken: '', tokenType: '' }]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('treats a blank expiresAt string as no expiry', async () => {
    const insertedRows = [{ id: 't1', idToken: 'BLANK', tokenType: 'ISO14443', driverId: null }];
    setupDbResults([], insertedRows, []);

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
    setupDbResults([], insertedRows, []);

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
