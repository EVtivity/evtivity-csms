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
  refreshTokens: {
    id: 'id',
    userId: 'userId',
    driverId: 'driverId',
    tokenHash: 'tokenHash',
    type: 'type',
    name: 'name',
    lastUsedAt: 'lastUsedAt',
    expiresAt: 'expiresAt',
    revokedAt: 'revokedAt',
    createdAt: 'createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
}));

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyLastUsed,
} from '../services/api-key.service.js';
import { db } from '@evtivity/database';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('createApiKey', () => {
  it('inserts with type=api_key and returns rawToken, name, expiresAt, id, createdAt', async () => {
    const createdAt = new Date();
    setupDbResults([{ id: 1, createdAt }]);

    const result = await createApiKey({
      userId: 'usr_abc123',
      name: 'My API Key',
      expiresAt: new Date('2027-01-01'),
    });

    expect(result.rawToken).toBeDefined();
    expect(result.rawToken).toHaveLength(64);
    expect(result.id).toBe(1);
    expect(result.name).toBe('My API Key');
    expect(result.expiresAt).toEqual(new Date('2027-01-01'));
    expect(result.createdAt).toBe(createdAt);
    expect(db.insert).toHaveBeenCalled();
  });

  it('creates a non-expiring key when expiresAt is null', async () => {
    const createdAt = new Date();
    setupDbResults([{ id: 2, createdAt }]);

    const result = await createApiKey({
      userId: 'usr_abc123',
      name: 'No Expiry Key',
    });

    expect(result.rawToken).toHaveLength(64);
    expect(result.expiresAt).toBeNull();
    expect(result.id).toBe(2);
    expect(db.insert).toHaveBeenCalled();
  });
});

describe('listApiKeys', () => {
  it('filters by userId, type=api_key, non-revoked, and orders by createdAt desc', async () => {
    const rows = [
      { id: 1, name: 'Key 1', createdAt: new Date(), expiresAt: null, lastUsedAt: null },
      {
        id: 2,
        name: 'Key 2',
        createdAt: new Date(),
        expiresAt: new Date(),
        lastUsedAt: new Date(),
      },
    ];
    setupDbResults(rows);

    const result = await listApiKeys('usr_abc123');

    expect(result).toEqual(rows);
    expect(db.select).toHaveBeenCalled();
  });
});

describe('revokeApiKey', () => {
  it('sets revokedAt and returns true when a matching row is found', async () => {
    setupDbResults([{ id: 5 }]);

    const result = await revokeApiKey(5, 'usr_abc123');

    expect(result).toBe(true);
    expect(db.update).toHaveBeenCalled();
  });

  it('returns false when no matching row exists', async () => {
    setupDbResults([]);

    const result = await revokeApiKey(99, 'usr_wrong');

    expect(result).toBe(false);
    expect(db.update).toHaveBeenCalled();
  });
});

describe('updateApiKeyLastUsed', () => {
  it('updates lastUsedAt by tokenHash', async () => {
    setupDbResults([]);

    await updateApiKeyLastUsed('somehash');

    expect(db.update).toHaveBeenCalled();
  });
});
