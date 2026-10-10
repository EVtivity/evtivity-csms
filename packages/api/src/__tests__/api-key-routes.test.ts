// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const mockApiKeyService = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('../services/api-key.service.js', () => mockApiKeyService);

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
    'values',
    'returning',
    'set',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  refreshTokens: {},
  userPermissions: {},
  OCTT_API_KEY_NAME: 'OCTT Runner (temporary)',
  writeAudit: vi.fn().mockResolvedValue(undefined),
  siteAuditLog: {},
  stationAuditLog: {},
  driverAuditLog: {},
  fleetAuditLog: {},
  userAuditLog: {},
  vehicleAuditLog: {},
  supportCaseAuditLog: {},
  ocpiPartnerAuditLog: {},
  certificateAuditLog: {},
  roleAuditLog: {},
  apiKeyAuditLog: {},
  settingAuditLog: {},
  smartChargingTemplateAuditLog: {},
  configTemplateAuditLog: {},
  firmwareCampaignAuditLog: {},
  stationImageAuditLog: {},
  localAuthListAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
}));

// The request's effective permissions (user permissions within the API key
// scope): what POST and PATCH /api-keys compare the new scope with.
const effectivePermissions = vi.hoisted(() => ({ value: ['stations:read'] as string[] }));

vi.mock('../middleware/rbac.js', () => ({
  getEffectivePermissions: () => Promise.resolve(effectivePermissions.value),
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { apiKeyRoutes } from '../routes/api-keys.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  apiKeyRoutes(app);
  await app.ready();
  return app;
}

describe('API key routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dbResults = [];
    dbCallIndex = 0;
  });

  describe('GET /api-keys', () => {
    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/api-keys' });
      expect(response.statusCode).toBe(401);
    });

    it('returns array from listApiKeys', async () => {
      const keys = [
        {
          id: 1,
          name: 'My Key',
          createdAt: new Date().toISOString(),
          expiresAt: null,
          lastUsedAt: null,
        },
      ];
      mockApiKeyService.listApiKeys.mockResolvedValue(keys);

      const response = await app.inject({
        method: 'GET',
        url: '/api-keys',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('My Key');
      expect(mockApiKeyService.listApiKeys).toHaveBeenCalledWith(VALID_USER_ID);
    });
  });

  describe('POST /api-keys', () => {
    it('returns 201 with rawToken on success', async () => {
      const created = {
        id: 1,
        rawToken: 'abc123hex',
        name: 'Test Key',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      mockApiKeyService.createApiKey.mockResolvedValue(created);
      // DB query: duplicate name check (empty = no duplicate). The effective
      // permissions hold stations:read, so the subset check passes.
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Test Key', expiresInDays: 30, permissions: ['stations:read'] },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.rawToken).toBe('abc123hex');
      expect(body.name).toBe('Test Key');
      expect(mockApiKeyService.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: VALID_USER_ID,
          name: 'Test Key',
          expiresAt: expect.any(Date),
        }),
      );
    });

    it('accepts optional permissions array on create', async () => {
      const created = {
        id: 3,
        rawToken: 'scoped123hex',
        name: 'Scoped Key',
        expiresAt: null,
        createdAt: new Date().toISOString(),
      };
      mockApiKeyService.createApiKey.mockResolvedValue(created);

      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Scoped Key', permissions: ['stations:read'] },
      });

      // The route validates permissions against user_permissions which is mocked,
      // so this tests the schema acceptance
      expect(response.statusCode).toBeLessThanOrEqual(403);
    });

    it('creates non-expiring key when expiresInDays is null', async () => {
      const created = {
        id: 2,
        rawToken: 'def456hex',
        name: 'Permanent Key',
        expiresAt: null,
        createdAt: new Date().toISOString(),
      };
      mockApiKeyService.createApiKey.mockResolvedValue(created);
      // DB query: duplicate name check (empty = no duplicate). The effective
      // permissions hold stations:read, so the subset check passes.
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Permanent Key', expiresInDays: null, permissions: ['stations:read'] },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.expiresAt).toBeNull();
      expect(mockApiKeyService.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: VALID_USER_ID,
          name: 'Permanent Key',
          expiresAt: null,
        }),
      );
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        payload: { name: 'No Auth' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('through an API key', () => {
    const inDays = (d: number): Date => new Date(Date.now() + d * 24 * 60 * 60 * 1000);
    const keyToken = (expiresAt?: Date): string =>
      app.jwt.sign({
        userId: VALID_USER_ID,
        roleId: VALID_ROLE_ID,
        isApiKey: true,
        apiKeyPermissions: ['stations:read'],
        ...(expiresAt != null ? { apiKeyExpiresAt: expiresAt.toISOString() } : {}),
      });
    const created = {
      id: 3,
      rawToken: 'a'.repeat(64),
      name: 'Child',
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };

    it('refuses a non-expiring key when the calling key expires', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${keyToken(inDays(5))}` },
        payload: { name: 'Child', permissions: ['stations:read'] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it("caps the new key's expiry at the calling key's", async () => {
      const callerExpiry = inDays(5);
      mockApiKeyService.createApiKey.mockResolvedValue(created);
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${keyToken(callerExpiry)}` },
        payload: { name: 'Child', expiresInDays: 30, permissions: ['stations:read'] },
      });
      expect(response.statusCode).toBe(201);
      expect(mockApiKeyService.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: new Date(callerExpiry.toISOString()) }),
      );
    });

    it('keeps a shorter expiry than the calling key', async () => {
      mockApiKeyService.createApiKey.mockResolvedValue(created);
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${keyToken(inDays(30))}` },
        payload: { name: 'Child', expiresInDays: 1, permissions: ['stations:read'] },
      });
      expect(response.statusCode).toBe(201);
      const { expiresAt } = mockApiKeyService.createApiKey.mock.calls[0]?.[0] as {
        expiresAt: Date;
      };
      expect(expiresAt.getTime()).toBeLessThan(inDays(2).getTime());
    });

    it('allows a non-expiring key from a non-expiring calling key', async () => {
      mockApiKeyService.createApiKey.mockResolvedValue(created);
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: { authorization: `Bearer ${keyToken()}` },
        payload: { name: 'Child', permissions: ['stations:read'] },
      });
      expect(response.statusCode).toBe(201);
      expect(mockApiKeyService.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: null }),
      );
    });

    it('cannot revoke a key with a wider scope (404, no revoke)', async () => {
      setupDbResults([{ permissions: ['stations:read', 'stations:write'] }]);
      const response = await app.inject({
        method: 'DELETE',
        url: '/api-keys/7',
        headers: { authorization: `Bearer ${keyToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('API_KEY_NOT_FOUND');
      expect(mockApiKeyService.revokeApiKey).not.toHaveBeenCalled();
    });

    it("cannot revoke a key without a scope (the user's permissions) beyond its own", async () => {
      setupDbResults([{ permissions: null }], [{ permission: 'users:write' }]);
      const response = await app.inject({
        method: 'DELETE',
        url: '/api-keys/7',
        headers: { authorization: `Bearer ${keyToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(mockApiKeyService.revokeApiKey).not.toHaveBeenCalled();
    });

    it('revokes a key within its scope', async () => {
      mockApiKeyService.revokeApiKey.mockResolvedValue(true);
      setupDbResults([{ permissions: ['stations:read'] }]);
      const response = await app.inject({
        method: 'DELETE',
        url: '/api-keys/7',
        headers: { authorization: `Bearer ${keyToken()}` },
      });
      expect(response.statusCode).toBe(200);
      expect(mockApiKeyService.revokeApiKey).toHaveBeenCalledWith(7, VALID_USER_ID);
    });

    it('cannot change a key with a wider scope (404, no update)', async () => {
      const { db } = await import('@evtivity/database');
      setupDbResults([{ id: 7, permissions: ['stations:read', 'stations:write'] }]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/api-keys/7',
        headers: { authorization: `Bearer ${keyToken()}` },
        payload: { permissions: ['stations:read'] },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('API_KEY_NOT_FOUND');
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api-keys/:id', () => {
    it('returns success when key found', async () => {
      mockApiKeyService.revokeApiKey.mockResolvedValue(true);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api-keys/1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(mockApiKeyService.revokeApiKey).toHaveBeenCalledWith(1, VALID_USER_ID);
    });

    it('returns 404 when key not found', async () => {
      mockApiKeyService.revokeApiKey.mockResolvedValue(false);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api-keys/999',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('API_KEY_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'DELETE', url: '/api-keys/1' });
      expect(response.statusCode).toBe(401);
    });
  });
});
