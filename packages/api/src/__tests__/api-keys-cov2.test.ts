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

// Whether the actor holds every permission of the target user (the admin
// routes on another user's keys).
const canAdminister = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/user-management-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/user-management-scope.js')>()),
  getUserManagementActor: vi.fn().mockResolvedValue({ userId: 'usr_000000000001', siteIds: null }),
  canAdministerUser: vi.fn(() => Promise.resolve(canAdminister.value)),
}));

import { registerAuth } from '../plugins/auth.js';
import { apiKeyRoutes } from '../routes/api-keys.js';
import { db, writeAudit } from '@evtivity/database';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  apiKeyRoutes(app);
  await app.ready();
  return app;
}

describe('API key routes: validation and update paths', () => {
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
    setupDbResults();
    effectivePermissions.value = ['stations:read'];
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function patch(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api-keys/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  describe('POST /api-keys', () => {
    it('rejects the reserved OCTT runner name regardless of case and whitespace', async () => {
      const res = await post({
        name: '  octt runner (TEMPORARY) ',
        permissions: ['stations:read'],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'This API key name is reserved',
        code: 'VALIDATION_ERROR',
      });
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it('returns 409 when an active key with the same name exists', async () => {
      setupDbResults([{ id: 7 }]);
      const res = await post({ name: 'Dup', permissions: ['stations:read'] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_API_KEY_NAME');
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it('returns 400 listing every permission missing from the catalog', async () => {
      setupDbResults([]);
      const res = await post({
        name: 'Bad',
        permissions: ['stations:read', 'bogus:perm', 'other:thing'],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Invalid permissions: bogus:perm, other:thing',
        code: 'INVALID_PERMISSIONS',
      });
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it('refuses a narrow key minting a wider key: the request scope, not the owner, decides', async () => {
      // The owner holds drivers:write, the calling key only stations:read.
      effectivePermissions.value = ['stations:read'];
      setupDbResults([]);
      const res = await post({ name: 'Wider', permissions: ['drivers:write'] });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PERMISSIONS_EXCEED_OWN');
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it('returns 403 when requested permissions exceed the creator', async () => {
      setupDbResults([]);
      const res = await post({ name: 'Wide', permissions: ['stations:read', 'drivers:write'] });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PERMISSIONS_EXCEED_OWN');
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api-keys/:id', () => {
    it('returns 404 when the key is not an active key of the user', async () => {
      setupDbResults([]);
      const res = await patch('5', { permissions: ['stations:read'] });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 400 for permissions not in the catalog', async () => {
      setupDbResults([{ id: 5, permissions: ['stations:read'] }]);
      const res = await patch('5', { permissions: ['nope:nope'] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Invalid permissions: nope:nope',
        code: 'INVALID_PERMISSIONS',
      });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the new scope exceeds the owner permissions', async () => {
      setupDbResults([{ id: 5, permissions: ['stations:read'] }]);
      const res = await patch('5', { permissions: ['drivers:write'] });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PERMISSIONS_EXCEED_OWN');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('updates permissions and audits before and after', async () => {
      effectivePermissions.value = ['stations:read', 'drivers:read'];
      setupDbResults([{ id: 5, permissions: ['stations:read'] }], []);
      const res = await patch('5', { permissions: ['drivers:read'] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(db.update).toHaveBeenCalled();
      expect(writeAudit).toHaveBeenCalledWith(
        { table: {}, idColumn: 'api_key_id' },
        expect.objectContaining({
          entityId: '5',
          action: 'updated',
          before: { id: 5, permissions: ['stations:read'] },
          after: { id: 5, permissions: ['drivers:read'] },
        }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("another user's keys", () => {
    const TARGET = 'usr_000000000002';

    beforeEach(() => {
      canAdminister.value = true;
    });

    it('lists the active keys of a user the actor administers', async () => {
      mockApiKeyService.listApiKeys.mockResolvedValue([
        {
          id: 3,
          name: 'ci',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: null,
          lastUsedAt: null,
          permissions: ['stations:read'],
          tokenSuffix: 'abcd',
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/users/${TARGET}/api-keys`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(mockApiKeyService.listApiKeys).toHaveBeenCalledWith(TARGET);
    });

    it('answers 404 USER_NOT_FOUND for a user the actor cannot administer', async () => {
      canAdminister.value = false;
      const list = await app.inject({
        method: 'GET',
        url: `/users/${TARGET}/api-keys`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(404);
      expect(list.json().code).toBe('USER_NOT_FOUND');
      const revoke = await app.inject({
        method: 'DELETE',
        url: `/users/${TARGET}/api-keys/3`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(revoke.statusCode).toBe(404);
      expect(mockApiKeyService.revokeApiKey).not.toHaveBeenCalled();
    });

    it('revokes a key of the user and audits it', async () => {
      mockApiKeyService.revokeApiKey.mockResolvedValue(true);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${TARGET}/api-keys/3`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(mockApiKeyService.revokeApiKey).toHaveBeenCalledWith(3, TARGET);
      expect(writeAudit).toHaveBeenCalledWith(
        { table: {}, idColumn: 'api_key_id' },
        expect.objectContaining({ entityId: '3', action: 'revoked', after: { userId: TARGET } }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('answers 404 API_KEY_NOT_FOUND for a key the user does not hold', async () => {
      mockApiKeyService.revokeApiKey.mockResolvedValue(false);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${TARGET}/api-keys/99`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('API_KEY_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });
});
