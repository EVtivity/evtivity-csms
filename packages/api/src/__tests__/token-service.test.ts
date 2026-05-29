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

vi.mock('../lib/pubsub.js', () => ({
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
  exportTokensCsv,
  importTokensCsv,
  DuplicateTokenError,
} from '../services/token.service.js';

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
