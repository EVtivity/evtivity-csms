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

vi.mock('../middleware/rbac.js', () => ({
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
      setupDbResults([{ id: 7 }], [{ permission: 'stations:read' }]);
      const res = await post({ name: 'Dup', permissions: ['stations:read'] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_API_KEY_NAME');
      expect(mockApiKeyService.createApiKey).not.toHaveBeenCalled();
    });

    it('returns 400 listing every permission missing from the catalog', async () => {
      setupDbResults([], [{ permission: 'stations:read' }]);
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

    it('returns 403 when requested permissions exceed the creator', async () => {
      setupDbResults([], [{ permission: 'stations:read' }]);
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
      setupDbResults(
        [{ id: 5, permissions: ['stations:read'] }],
        [{ permission: 'stations:read' }],
      );
      const res = await patch('5', { permissions: ['drivers:write'] });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PERMISSIONS_EXCEED_OWN');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('updates permissions and audits before and after', async () => {
      setupDbResults(
        [{ id: 5, permissions: ['stations:read'] }],
        [{ permission: 'stations:read' }, { permission: 'drivers:read' }],
        [],
      );
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
});
