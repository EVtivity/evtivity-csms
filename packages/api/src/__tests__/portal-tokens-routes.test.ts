// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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
    'for',
    'set',
    'onConflictDoUpdate',
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
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
  driverTokens: {},
  drivers: {},
  users: {},
  tokenAuditLog: {},
  stationLocalAuthEntries: {},
  stationLocalAuthVersions: {},
  vehicles: {},
  writeAudit: vi.fn().mockResolvedValue(undefined),
  isDriverRfidSelfServiceEnabled: vi.fn(async () => true),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  ne: vi.fn(),
}));

vi.mock('@evtivity/lib', async () => ({
  // The real OCPI token type rule (the token service decides tombstones with it).
  ...(await vi.importActual<Record<string, unknown>>('../../../lib/src/ocpi-token-types.js')),
  dispatchDriverNotification: vi.fn().mockResolvedValue(undefined),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { db, isDriverRfidSelfServiceEnabled } from '@evtivity/database';
import { portalTokenRoutes } from '../routes/portal/tokens.js';

const DRIVER_ID = 'drv_000000000001';
const TOKEN_ID = 'dtk_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalTokenRoutes);
  await app.ready();
  return app;
}

describe('Portal token routes', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('GET /v1/portal/tokens', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/tokens' });
      expect(response.statusCode).toBe(401);
    });

    it('returns token list', async () => {
      setupDbResults([
        {
          id: TOKEN_ID,
          driverId: DRIVER_ID,
          idToken: 'ABCD1234',
          tokenType: 'ISO14443',
          isActive: true,
          expiresAt: null,
          label: null,
          deactivatedBy: null,
          createdAt: new Date(),
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].idToken).toBe('ABCD1234');
    });
  });

  describe('POST /v1/portal/tokens', () => {
    it('creates a token', async () => {
      const newToken = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'NEWTOKEN01',
        tokenType: 'ISO14443',
        isActive: true,
        expiresAt: null,
        label: null,
        deactivatedBy: null,
        createdAt: new Date(),
      };
      // existing check (none), the driver (active), another driver's vehicle
      // with this id (none), insert returning
      setupDbResults([], [{ isActive: true }], [], [newToken]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'NEWTOKEN01' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().idToken).toBe('NEWTOKEN01');
    });

    it("returns 409 VEHICLE_ID_IN_USE for another driver's vehicle id", async () => {
      setupDbResults([], [{ isActive: true }], [{ id: 'veh_other' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        // An ISO 15118-20 EVCCID has no shape to detect, so the 409 stays.
        payload: { idToken: 'EVCC-15118-20-ID' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('VEHICLE_ID_IN_USE');
    });

    it('refuses a vehicle-shaped card value with 400 before any lookup', async () => {
      for (const idToken of ['5YJ3E1EA7KF317000', '92D50A693F80', '92-d5-0a-69-3f-80']) {
        setupDbResults();
        const response = await app.inject({
          method: 'POST',
          url: '/portal/tokens',
          headers: { authorization: `Bearer ${driverToken}` },
          payload: { idToken },
        });
        expect(response.statusCode, idToken).toBe(400);
        expect(response.json().code).toBe('VALIDATION_ERROR');
      }
    });

    it('refuses the vehicle id card types', async () => {
      for (const tokenType of ['VIN', 'EVCCID', 'MacAddress']) {
        const response = await app.inject({
          method: 'POST',
          url: '/portal/tokens',
          headers: { authorization: `Bearer ${driverToken}` },
          payload: { idToken: '92D50A693F80', tokenType },
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('returns 409 for duplicate token', async () => {
      setupDbResults([{ id: 'dtk_existing00001' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'ABCD1234' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('TOKEN_DUPLICATE');
    });

    it('rejects non-alphanumeric token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'AB!@#' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects too-short token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'AB' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/portal/tokens/:id', () => {
    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when token belongs to another driver', async () => {
      // The ownership filter is part of the lookup: no row for this driver.
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('toggles token active status', async () => {
      const ownRow = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'ABCD1234',
        tokenType: 'ISO14443',
        isActive: true,
        expiresAt: null,
        label: null,
        deactivatedBy: null,
        createdAt: new Date(),
      };
      const updatedToken = { ...ownRow, isActive: false, deactivatedBy: 'driver' };
      // 1) Route's ownership check
      // 2) tokenService.updateToken: select current row (locked)
      // 3) tokenService.updateToken: the driver row (FOR SHARE)
      // 4) tokenService.updateToken: update returning
      // 5) stations holding the token (none)
      // 6) Route re-reads the token for the response
      setupDbResults(
        [ownRow],
        [ownRow],
        [{ isActive: true, erasedAt: null }],
        [updatedToken],
        [],
        [updatedToken],
      );
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().isActive).toBe(false);
    });

    it('answers 404 when the card moved to another driver after the ownership read (PP-L1)', async () => {
      const ownRow = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'ABCD1234',
        tokenType: 'ISO14443',
        isActive: true,
        expiresAt: null,
        label: null,
        deactivatedBy: null,
        createdAt: new Date(),
      };
      // The route's read sees the driver's card, the locked row another driver's.
      setupDbResults([ownRow], [{ ...ownRow, driverId: 'drv_other' }]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { label: 'Mine' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });
  });

  describe('RFID self-service off (portal.rfidSelfServiceEnabled)', () => {
    const OTHER_ID = 'dtk_000000000099';

    beforeEach(() => {
      vi.mocked(isDriverRfidSelfServiceEnabled).mockResolvedValue(false);
    });

    afterEach(() => {
      vi.mocked(isDriverRfidSelfServiceEnabled).mockResolvedValue(true);
    });

    function expectRefused(response: { statusCode: number; json: () => { code: string } }) {
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('RFID_SELF_SERVICE_DISABLED');
    }

    it('refuses a new card before any query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'NEWTOKEN01' },
      });
      expectRefused(response);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['a rename', { label: 'Work' }],
      ['a reactivation', { isActive: true }],
      ['a deactivation', { isActive: false }],
      ['a rename and a deactivation', { isActive: false, label: 'Lost' }],
    ])(
      'refuses %s for an own, a foreign or an unknown id alike, before the lookup',
      async (_n, payload) => {
        for (const id of [TOKEN_ID, OTHER_ID]) {
          const response = await app.inject({
            method: 'PATCH',
            url: `/portal/tokens/${id}`,
            headers: { authorization: `Bearer ${driverToken}` },
            payload,
          });
          expectRefused(response);
        }
        expect(db.select).not.toHaveBeenCalled();
      },
    );

    it('still answers 400 for an empty PATCH body', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses a removal for any id before the lookup', async () => {
      for (const id of [TOKEN_ID, OTHER_ID]) {
        const response = await app.inject({
          method: 'DELETE',
          url: `/portal/tokens/${id}`,
          headers: { authorization: `Bearer ${driverToken}` },
        });
        expectRefused(response);
      }
      expect(db.select).not.toHaveBeenCalled();
    });

    it('still lists the cards', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('answers 403 when the setting turns off between the route check and the write', async () => {
      const ownRow = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'ABCD1234',
        tokenType: 'ISO14443',
        isActive: true,
        expiresAt: null,
        label: null,
        deactivatedBy: null,
        createdAt: new Date(),
      };
      for (const request of [
        { method: 'PATCH' as const, url: `/portal/tokens/${TOKEN_ID}`, payload: { label: 'X' } },
        { method: 'DELETE' as const, url: `/portal/tokens/${TOKEN_ID}` },
        { method: 'POST' as const, url: '/portal/tokens', payload: { idToken: 'NEWTOKEN02' } },
      ]) {
        setupDbResults([ownRow]);
        vi.mocked(isDriverRfidSelfServiceEnabled)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        const response = await app.inject({
          ...request,
          headers: { authorization: `Bearer ${driverToken}` },
        });
        expectRefused(response);
      }
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});
