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
    expiresAt: 'expiresAt',
    revokedAt: 'revokedAt',
    createdAt: 'createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
}));

import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  revokeAllDriverRefreshTokens,
} from '../services/refresh-token.service.js';
import { db } from '@evtivity/database';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('createRefreshToken', () => {
  it('returns rawToken and expiresAt approximately 30 days out', async () => {
    setupDbResults([]);

    const before = Date.now();
    const result = await createRefreshToken({ userId: 'usr_abc123' });
    const after = Date.now();

    expect(result.rawToken).toBeDefined();
    expect(result.rawToken).toHaveLength(64); // 32 bytes -> 64 hex chars
    expect(result.expiresAt).toBeInstanceOf(Date);

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs);

    expect(db.insert).toHaveBeenCalled();
  });

  it('creates a token for a driver', async () => {
    setupDbResults([]);

    const result = await createRefreshToken({ driverId: 'drv_xyz789' });

    expect(result.rawToken).toHaveLength(64);
    expect(db.insert).toHaveBeenCalled();
  });
});

describe('validateAndRotateRefreshToken', () => {
  it('returns userId/driverId and revokes old token for a valid token', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const row = {
      id: 42,
      userId: 'usr_abc123',
      driverId: null,
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: futureDate,
      revokedAt: null,
      createdAt: new Date(),
    };
    // First call: select returns the row. Second call: update (revoke).
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('raw-token-value');

    expect(result).toEqual({
      userId: 'usr_abc123',
      driverId: null,
      tokenId: 42,
    });
    expect(db.update).toHaveBeenCalled();
  });

  it('returns null and revokes an expired token', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60);
    const row = {
      id: 10,
      userId: 'usr_abc123',
      driverId: null,
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: pastDate,
      revokedAt: null,
      createdAt: new Date(),
    };
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('expired-token');

    expect(result).toBeNull();
    expect(db.update).toHaveBeenCalled();
  });

  it('returns null for a revoked token (not found by query)', async () => {
    // The query filters by isNull(revokedAt), so a revoked token returns empty
    setupDbResults([]);

    const result = await validateAndRotateRefreshToken('revoked-token');

    expect(result).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns null for a non-existent token', async () => {
    setupDbResults([]);

    const result = await validateAndRotateRefreshToken('nonexistent-token');

    expect(result).toBeNull();
  });

  it('accepts a token with null expiresAt (non-expiring)', async () => {
    const row = {
      id: 99,
      userId: null,
      driverId: 'drv_xyz789',
      tokenHash: 'somehash',
      type: 'api_key',
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('non-expiring-token');

    expect(result).toEqual({
      userId: null,
      driverId: 'drv_xyz789',
      tokenId: 99,
    });
  });
});

describe('revokeRefreshToken', () => {
  it('revokes a token by raw value', async () => {
    setupDbResults([]);

    await revokeRefreshToken('some-raw-token');

    expect(db.update).toHaveBeenCalled();
  });
});

describe('revokeAllUserRefreshTokens', () => {
  it('revokes all tokens for a user', async () => {
    setupDbResults([]);

    await revokeAllUserRefreshTokens('usr_abc123');

    expect(db.update).toHaveBeenCalled();
  });
});

describe('revokeAllDriverRefreshTokens', () => {
  it('revokes all tokens for a driver', async () => {
    setupDbResults([]);

    await revokeAllDriverRefreshTokens('drv_xyz789');

    expect(db.update).toHaveBeenCalled();
  });
});
