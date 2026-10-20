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
  drivers: { id: 'id', sessionVersion: 'sessionVersion' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
  sql: vi.fn(() => ({ type: 'sql' })),
}));

vi.mock('../lib/driver-active.js', () => ({ announceDriverSessionChange: vi.fn() }));

import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  bumpDriverSessionVersion,
  endDriverSessions,
  revokeAllUserSessions,
} from '../services/refresh-token.service.js';
import { db, drivers, refreshTokens } from '@evtivity/database';
import { announceDriverSessionChange } from '../lib/driver-active.js';
import { DEFAULT_SESSION_LIFETIMES } from '@evtivity/lib/session-lifetimes';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('createRefreshToken', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function expectExpiresInDays(
    opts: Parameters<typeof createRefreshToken>[0],
    days: number,
  ): Promise<void> {
    const before = Date.now();
    const result = await createRefreshToken(opts);
    const after = Date.now();
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + days * DAY_MS);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + days * DAY_MS);
    const chain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session', expiresAt: result.expiresAt }),
    );
  }

  it('returns a 64-character raw token and a row that expires after the default operator days', async () => {
    setupDbResults([]);
    const result = await createRefreshToken({
      userId: 'usr_abc123',
      lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
    });
    expect(result.rawToken).toHaveLength(64); // 32 bytes -> 64 hex chars
    await expectExpiresInDays(
      { userId: 'usr_abc123', lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays },
      30,
    );
  });

  it('stores the expiry the caller gives: 7 days for an operator, 60 for a driver', async () => {
    await expectExpiresInDays({ userId: 'usr_abc123', lifetimeDays: 7 }, 7);
    await expectExpiresInDays({ driverId: 'drv_xyz789', deviceId: 'dev-1', lifetimeDays: 60 }, 60);
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
    // SELECT returns the row, then the atomic CAS UPDATE returns
    // [{ id: 42 }] to signal the rotation won the race (only proceeds when
    // revoked_at WAS NULL at update time).
    setupDbResults([row], [{ id: 42 }]);

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

  it('returns null when the atomic rotation loses the race (returning() empty)', async () => {
    // Two concurrent callers race on the same valid token. The SELECT
    // succeeds for both because the row was unrevoked when read. The
    // CAS UPDATE (WHERE id = X AND revoked_at IS NULL) only the first
    // caller succeeds; the second sees zero rows in returning() and must
    // be rejected as if the token were already revoked.
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const row = {
      id: 7,
      userId: 'usr_abc123',
      driverId: null,
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: futureDate,
      revokedAt: null,
      createdAt: new Date(),
    };
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('replayed-token');

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
    // Same as the valid-token case: SELECT then atomic CAS returning the
    // revoked row id signals the rotation won.
    setupDbResults([row], [{ id: 99 }]);

    const result = await validateAndRotateRefreshToken('non-expiring-token');

    expect(result).toEqual({
      userId: null,
      driverId: 'drv_xyz789',
      tokenId: 99,
    });
  });

  it('returns null without theft-revocation for a token revoked inside the grace window', async () => {
    // Revoked 5s ago (< 30s grace) -> legitimate concurrent rotation.
    const row = {
      id: 11,
      userId: 'usr_abc123',
      driverId: null,
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(Date.now() - 5_000),
      createdAt: new Date(),
    };
    setupDbResults([row]);

    const result = await validateAndRotateRefreshToken('recently-rotated-token');

    expect(result).toBeNull();
    // No mass-revocation: the grace window swallows the replay silently.
    expect(db.update).not.toHaveBeenCalled();
  });

  it('revokes all user sessions when a token revoked outside the grace window is replayed', async () => {
    // Revoked 60s ago (> 30s grace) -> treat as theft, revoke every session.
    const row = {
      id: 12,
      userId: 'usr_theft',
      driverId: null,
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    };
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('stolen-token');

    expect(result).toBeNull();
    // revokeAllUserSessions fired its single mass-revocation UPDATE.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('revokes all driver tokens when a driver token is replayed outside the grace window', async () => {
    const row = {
      id: 13,
      userId: null,
      driverId: 'drv_theft',
      tokenHash: 'somehash',
      type: 'session',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    };
    setupDbResults([row], []);

    const result = await validateAndRotateRefreshToken('stolen-driver-token');

    expect(result).toBeNull();
    // The session version (access tokens) and every refresh token.
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenCalledWith(drivers);
    expect(db.update).toHaveBeenCalledWith(refreshTokens);
    expect(announceDriverSessionChange).toHaveBeenCalledWith('drv_theft');
  });
});

describe('revokeAllUserSessions', () => {
  it('revokes only session-type tokens for a user', async () => {
    setupDbResults([]);

    await revokeAllUserSessions('usr_abc123');

    expect(db.update).toHaveBeenCalledTimes(1);
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

describe('bumpDriverSessionVersion', () => {
  it('raises the session version and ends the open streams', async () => {
    setupDbResults([{ sessionVersion: 3 }]);

    expect(await bumpDriverSessionVersion('drv_xyz789')).toBe(3);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith(drivers);
    expect(announceDriverSessionChange).toHaveBeenCalledWith('drv_xyz789');
  });

  it('returns null for an unknown driver', async () => {
    setupDbResults([]);
    expect(await bumpDriverSessionVersion('drv_gone')).toBeNull();
  });

  it('still ends the open streams when the update fails', async () => {
    vi.mocked(db.update).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(bumpDriverSessionVersion('drv_xyz789')).rejects.toThrow('db down');
    expect(announceDriverSessionChange).toHaveBeenCalledWith('drv_xyz789');
  });
});

describe('endDriverSessions', () => {
  it('raises the session version, then revokes every refresh token', async () => {
    setupDbResults([{ sessionVersion: 1 }], []);

    await endDriverSessions('drv_xyz789');

    expect(vi.mocked(db.update).mock.calls.map((c) => c[0])).toEqual([drivers, refreshTokens]);
    expect(announceDriverSessionChange).toHaveBeenCalledWith('drv_xyz789');
  });
});
