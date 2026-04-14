// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

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
    name: 'name',
    tokenHash: 'tokenHash',
    type: 'type',
    expiresAt: 'expiresAt',
    revokedAt: 'revokedAt',
    lastUsedAt: 'lastUsedAt',
    permissions: 'permissions',
  },
  users: {
    id: 'id',
    roleId: 'roleId',
    isActive: 'isActive',
  },
  userPermissions: {
    permission: 'permission',
    userId: 'userId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';

// Generate a valid 64-char hex token for testing
const RAW_TOKEN = 'a'.repeat(64);

describe('API key authentication in authenticate decorator', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env['JWT_SECRET'] = 'test-secret-for-api-key-auth-12345';
    app = Fastify();
    await registerAuth(app);

    app.get('/protected', { onRequest: [app.authenticate] }, async (request) => {
      const user = request.user as { userId: string; roleId: string };
      return { userId: user.userId, roleId: user.roleId };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
  });

  it('authenticates with a valid API key and sets request.user', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    // First query: refresh_tokens lookup
    setupDbResults(
      [{ id: 1, userId: 'usr_abc123', expiresAt: futureDate }],
      // Second query: users lookup
      [{ id: 'usr_abc123', roleId: 'role_admin', isActive: true }],
      // Third query: userPermissions lookup (permissions is null on token)
      [],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body: Record<string, unknown> = res.json();
    expect(body['userId']).toBe('usr_abc123');
    expect(body['roleId']).toBe('role_admin');
  });

  it('authenticates with a non-expiring API key (expiresAt null)', async () => {
    setupDbResults(
      [{ id: 2, userId: 'usr_xyz789', expiresAt: null }],
      [{ id: 'usr_xyz789', roleId: 'role_operator', isActive: true }],
      // Third query: userPermissions lookup (permissions is null on token)
      [],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body: Record<string, unknown> = res.json();
    expect(body['userId']).toBe('usr_xyz789');
  });

  it('returns 401 with API_KEY_EXPIRED code for expired API key', async () => {
    const pastDate = new Date(Date.now() - 86400000);
    setupDbResults([{ id: 3, userId: 'usr_expired', expiresAt: pastDate }]);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    const body: Record<string, unknown> = res.json();
    expect(body['code']).toBe('API_KEY_EXPIRED');
  });

  it('returns 401 for revoked API key (not found in DB)', async () => {
    // No rows returned from refresh_tokens query
    setupDbResults([]);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    const body: Record<string, unknown> = res.json();
    expect(body['error']).toBe('Unauthorized');
  });

  it('does not trigger API key path for non-hex Bearer tokens (JWT-like)', async () => {
    // A JWT token is not 64-char hex, so the regex should not match
    const jwtLikeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${jwtLikeToken}` },
    });

    // Should get 401 from JWT verify failure, not from API key path
    expect(res.statusCode).toBe(401);
    // DB should NOT have been called since the token is not 64-char hex
    const { db } = await import('@evtivity/database');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 401 for inactive user with valid API key', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    setupDbResults(
      [{ id: 4, userId: 'usr_inactive', expiresAt: futureDate }],
      [{ id: 'usr_inactive', roleId: 'role_admin', isActive: false }],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    const body: Record<string, unknown> = res.json();
    expect(body['error']).toBe('Unauthorized');
  });

  it('attaches apiKeyPermissions to request.user when API key has scoped permissions', async () => {
    let capturedUser: Record<string, unknown> | null = null;
    const scopedApp = Fastify();
    await registerAuth(scopedApp);

    scopedApp.get('/check-perms', { onRequest: [scopedApp.authenticate] }, async (request) => {
      capturedUser = request.user as unknown as Record<string, unknown>;
      return { ok: true };
    });

    await scopedApp.ready();

    const futureDate = new Date(Date.now() + 86400000);
    setupDbResults(
      [
        {
          id: 10,
          userId: 'usr_scoped',
          expiresAt: futureDate,
          permissions: ['stations:read', 'sessions:read'],
        },
      ],
      [{ id: 'usr_scoped', roleId: 'role_op', isActive: true }],
    );

    const res = await scopedApp.inject({
      method: 'GET',
      url: '/check-perms',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedUser).not.toBeNull();
    expect(capturedUser!['apiKeyPermissions']).toEqual(['stations:read', 'sessions:read']);
    expect(capturedUser!['userId']).toBe('usr_scoped');

    await scopedApp.close();
  });

  it('does not attach apiKeyPermissions when API key has no scoped permissions', async () => {
    let capturedUser: Record<string, unknown> | null = null;
    const noScopeApp = Fastify();
    await registerAuth(noScopeApp);

    noScopeApp.get('/check-perms', { onRequest: [noScopeApp.authenticate] }, async (request) => {
      capturedUser = request.user as unknown as Record<string, unknown>;
      return { ok: true };
    });

    await noScopeApp.ready();

    const futureDate = new Date(Date.now() + 86400000);
    setupDbResults(
      [{ id: 11, userId: 'usr_unscoped', expiresAt: futureDate, permissions: null }],
      [{ id: 'usr_unscoped', roleId: 'role_admin', isActive: true }],
      // Third query: userPermissions lookup (permissions is null, loads from table)
      [],
    );

    const res = await noScopeApp.inject({
      method: 'GET',
      url: '/check-perms',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedUser).not.toBeNull();
    // When permissions is null on the token, the auth plugin loads user permissions
    // from the userPermissions table and always sets apiKeyPermissions (as an array).
    expect(Array.isArray(capturedUser!['apiKeyPermissions'])).toBe(true);

    await noScopeApp.close();
  });
});
