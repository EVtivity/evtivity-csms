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
  },
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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
}));

import {
  listTokens,
  getToken,
  createToken,
  updateToken,
  deleteToken,
  exportTokensCsv,
  importTokensCsv,
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
    const token = { id: 't1', idToken: 'NEW_TOKEN', tokenType: 'ISO14443' };
    setupDbResults([token]);

    const result = await createToken({ idToken: 'NEW_TOKEN', tokenType: 'ISO14443' });

    expect(result).toEqual(token);
  });
});

describe('updateToken', () => {
  it('returns updated token when found', async () => {
    const token = { id: 't1', idToken: 'UPDATED', tokenType: 'ISO15693' };
    setupDbResults([token]);

    const result = await updateToken('t1', { idToken: 'UPDATED', tokenType: 'ISO15693' });

    expect(result).toEqual(token);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await updateToken('nonexistent', { idToken: 'X' });

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

describe('exportTokensCsv', () => {
  it('returns CSV string with header and data rows', async () => {
    const rows = [
      { idToken: 'TOK1', tokenType: 'ISO14443', driverEmail: 'a@b.com', isActive: true },
      { idToken: 'TOK2', tokenType: 'ISO15693', driverEmail: null, isActive: false },
    ];
    setupDbResults(rows);

    const csv = await exportTokensCsv();

    const lines = csv.split('\n');
    expect(lines[0]).toBe('idToken,tokenType,driverEmail,isActive');
    expect(lines[1]).toBe('TOK1,ISO14443,a@b.com,true');
    expect(lines[2]).toBe('TOK2,ISO15693,,false');
  });
});

describe('importTokensCsv', () => {
  it('imports valid rows and returns count', async () => {
    // Row 1 has a driverEmail, so it triggers a driver lookup query
    // Row 2 has no driverEmail, so no lookup
    const driverRow = { id: 'driver-1' };
    setupDbResults(
      [driverRow], // driver lookup for row 1
      [], // batch insert result
    );

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
    setupDbResults(
      [], // driver lookup returns nothing
    );

    const result = await importTokensCsv([
      { idToken: 'T1', tokenType: 'ISO14443', driverEmail: 'unknown@example.com' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('driver not found');
    expect(result.errors[0]).toContain('unknown@example.com');
  });
});
