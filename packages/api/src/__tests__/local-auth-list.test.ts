// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';

// -- DB mock helpers --

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
    'onConflictDoNothing',
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
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  chargingStations: {},
  driverTokens: {},
  drivers: {},
  stationLocalAuthVersions: {},
  stationLocalAuthEntries: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

// -- PubSub mock --

let mockSubscribeCallback: ((raw: string) => void) | null = null;
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi
  .fn()
  .mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
    mockSubscribeCallback = cb;
    return { unsubscribe: mockUnsubscribe };
  });

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: mockSubscribe,
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { localAuthListRoutes } from '../routes/local-auth-list.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(localAuthListRoutes);
  await app.ready();
  return app;
}

describe('Local auth list routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    mockSubscribeCallback = null;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
    mockUnsubscribe.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      mockSubscribeCallback = cb;
      return { unsubscribe: mockUnsubscribe };
    });
  });

  // ===================================================================
  // GET /v1/stations/:stationId/local-auth-list
  // ===================================================================

  describe('GET /v1/stations/:stationId/local-auth-list', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/local-auth-list`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/local-auth-list`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 with version info and entries', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: true,
        ocppProtocol: 'ocpp2.1',
      };
      const versionRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        localVersion: 3,
        reportedVersion: 3,
        lastSyncAt: new Date().toISOString(),
        lastModifiedAt: null,
        lastVersionCheckAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const entry = {
        id: 1,
        stationId: VALID_STATION_ID,
        driverTokenId: 'dtk_000000000001',
        idToken: 'TOKEN001',
        tokenType: 'ISO14443',
        authStatus: 'Accepted',
        addedAt: new Date().toISOString(),
        pushedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        driverFirstName: 'John',
        driverLastName: 'Doe',
      };

      // 1. getStation, 2. getOrCreateVersionRow, 3. entries query, 4. count query
      setupDbResults([station], [versionRow], [entry], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/local-auth-list`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.localVersion).toBe(3);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].driverName).toBe('John Doe');
      expect(body.total).toBe(1);
    });
  });

  // ===================================================================
  // GET /v1/stations/:stationId/local-auth-list/available-tokens
  // ===================================================================

  describe('GET /v1/stations/:stationId/local-auth-list/available-tokens', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/available-tokens`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 with available tokens', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: true,
        ocppProtocol: 'ocpp2.1',
      };
      const existingEntries: unknown[] = [];
      const availableToken = {
        id: 'dtk_000000000002',
        idToken: 'TOKEN002',
        tokenType: 'ISO14443',
        driverFirstName: 'Jane',
        driverLastName: 'Smith',
      };

      // 1. getStation, 2. existing entries, 3. available tokens, 4. count
      setupDbResults([station], existingEntries, [availableToken], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/available-tokens`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].driverName).toBe('Jane Smith');
    });
  });

  // ===================================================================
  // POST /v1/stations/:stationId/local-auth-list/push
  // ===================================================================

  describe('POST /v1/stations/:stationId/local-auth-list/push', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/push`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 when station is offline', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: false,
        ocppProtocol: 'ocpp2.1',
      };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/push`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 200 on successful push', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: true,
        ocppProtocol: 'ocpp2.1',
      };
      const entriesWithTokenStatus = [
        { entryId: 1, isActive: true },
        { entryId: 2, isActive: true },
      ];
      const trackedEntries = [
        { idToken: 'TOKEN001', tokenType: 'ISO14443', authStatus: 'Accepted' },
        { idToken: 'TOKEN002', tokenType: 'ISO14443', authStatus: 'Accepted' },
      ];
      const versionRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        localVersion: 2,
        reportedVersion: 2,
        lastSyncAt: null,
        lastVersionCheckAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. getStation, 2. delete orphaned entries, 3. entries with token status,
      // 4. reconciled entries, 5. getOrCreateVersionRow,
      // 6. update version, 7. update pushedAt
      setupDbResults([station], [], entriesWithTokenStatus, trackedEntries, [versionRow], [], []);

      mockPublish.mockImplementation(async (_channel: string, data: string) => {
        if (_channel === 'ocpp_commands' && mockSubscribeCallback != null) {
          const cmd = JSON.parse(data);
          setTimeout(() => {
            mockSubscribeCallback!(
              JSON.stringify({
                commandId: cmd.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }, 10);
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/push`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('Accepted');
      expect(body.entriesCount).toBe(2);
      expect(body.version).toBe(3);
    });

    it('pushes empty list without localAuthorizationList field', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: true,
        ocppProtocol: 'ocpp2.1',
      };
      const versionRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        localVersion: 1,
        reportedVersion: 1,
        lastSyncAt: null,
        lastVersionCheckAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. getStation, 2. delete orphaned, 3. entries with token status (none),
      // 4. reconciled entries (none), 5. getOrCreateVersionRow,
      // 6. update version, 7. update pushedAt
      setupDbResults([station], [], [], [], [versionRow], [], []);

      let capturedPayload: Record<string, unknown> | undefined;
      mockPublish.mockImplementation(async (_channel: string, data: string) => {
        if (_channel === 'ocpp_commands' && mockSubscribeCallback != null) {
          const cmd = JSON.parse(data);
          capturedPayload = cmd.payload;
          setTimeout(() => {
            mockSubscribeCallback!(
              JSON.stringify({
                commandId: cmd.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }, 10);
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/push`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.entriesCount).toBe(0);
      expect(body.version).toBe(2);
      // localAuthorizationList must be omitted (not empty array) per OCPP minItems: 1
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload!.localAuthorizationList).toBeUndefined();
      expect(capturedPayload!.versionNumber).toBe(2);
      expect(capturedPayload!.updateType).toBe('Full');
    });
  });

  // ===================================================================
  // POST /v1/stations/:stationId/local-auth-list/add
  // ===================================================================

  describe('POST /v1/stations/:stationId/local-auth-list/add', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/add`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tokenIds: ['dtk_000000000001'] }),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 on successful add (DB-only, no OCPP)', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: false,
        ocppProtocol: 'ocpp2.1',
      };
      const allActiveTokens = [
        { id: 'dtk_000000000001', idToken: 'TOKEN001', tokenType: 'ISO14443' },
      ];

      const versionRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        localVersion: 0,
        reportedVersion: null,
        lastSyncAt: null,
        lastModifiedAt: null,
        lastVersionCheckAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. getStation, 2. fetch active tokens, 3. insert entry,
      // 4. getOrCreateVersionRow, 5. update lastModifiedAt
      setupDbResults([station], allActiveTokens, [], [versionRow], []);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/add`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tokenIds: ['dtk_000000000001'] }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.count).toBe(1);
      // No OCPP commands should have been published
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // POST /v1/stations/:stationId/local-auth-list/remove
  // ===================================================================

  describe('POST /v1/stations/:stationId/local-auth-list/remove', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/remove`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: [1] }),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 on successful remove (DB-only, no OCPP)', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        isOnline: false,
        ocppProtocol: 'ocpp2.1',
      };
      const existingEntries = [
        {
          id: 1,
          stationId: VALID_STATION_ID,
          driverTokenId: 'dtk_000000000001',
          idToken: 'TOKEN001',
          tokenType: 'ISO14443',
          authStatus: 'Accepted',
          addedAt: new Date().toISOString(),
          pushedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const versionRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        localVersion: 1,
        reportedVersion: 1,
        lastSyncAt: new Date().toISOString(),
        lastModifiedAt: null,
        lastVersionCheckAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. getStation, 2. fetch entries to remove, 3. delete entry,
      // 4. getOrCreateVersionRow, 5. update lastModifiedAt
      setupDbResults([station], existingEntries, [], [versionRow], []);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/local-auth-list/remove`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: [1] }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.count).toBe(1);
      // No OCPP commands should have been published
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });
});
