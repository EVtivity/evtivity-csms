// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
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
    'leftJoin',
    'innerJoin',
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
  },
  authorizeAttempts: {
    id: 'id',
    stationId: 'stationId',
    idToken: 'idToken',
    tokenType: 'tokenType',
    matchedTokenId: 'matchedTokenId',
    matchedDriverId: 'matchedDriverId',
    outcome: 'outcome',
    ocppVersion: 'ocppVersion',
    reason: 'reason',
    createdAt: 'createdAt',
  },
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
  },
  // Referenced by the correlated subquery that resolves the charging_sessions
  // row produced by the authorize attempt (joined on matched token + start
  // within 10 minutes of the attempt timestamp).
  chargingSessions: {
    id: 'id',
    tokenId: 'tokenId',
    startedAt: 'startedAt',
  },
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    ilike: vi.fn(),
    desc: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    sql: sqlTag,
  };
});

// Bypass RBAC entirely so the route handler is reached. The real authorize()
// middleware does a permission lookup against the DB which would balloon the
// mock surface; we test the handler logic here, not RBAC.
vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async () => {},
}));

import { authorizeAttemptRoutes } from '../routes/authorize-attempts.js';
import { registerAuth } from '../plugins/auth.js';
import * as drizzleOrmModule from 'drizzle-orm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(authorizeAttemptRoutes);
  await app.ready();
  return app;
}

describe('Authorize attempts route', () => {
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    app = await buildApp();
    operatorToken = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('GET /v1/authorize-attempts', () => {
    it('returns paginated list with stationDbId resolved from OCPP id', async () => {
      const row = {
        id: 1,
        stationOcppId: 'CS-0001',
        stationDbId: 'sta_xxxxxxxxxxxx',
        idToken: 'A1B2C3',
        tokenType: 'ISO14443',
        matchedTokenId: null,
        matchedDriverId: null,
        sessionId: null,
        outcome: 'accepted',
        ocppVersion: 'ocpp2.1',
        reason: 'active',
        createdAt: new Date(),
      };
      setupDbResults([row], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/authorize-attempts',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].stationOcppId).toBe('CS-0001');
      expect(body.data[0].stationDbId).toBe('sta_xxxxxxxxxxxx');
      expect(body.total).toBe(1);
    });

    it('returns empty list when no rows match', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/authorize-attempts?outcome=db_error',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
      expect(response.json().total).toBe(0);
    });

    it('filters by from/to as Date values, not the raw query strings', async () => {
      const { gte, lte } = drizzleOrmModule;
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/authorize-attempts?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(response.statusCode).toBe(200);
      // The timestamp column serializes its parameter with toISOString(), so a
      // string here fails at query time.
      expect(gte).toHaveBeenCalledWith('createdAt', new Date('2026-01-01T00:00:00Z'));
      expect(lte).toHaveBeenCalledWith('createdAt', new Date('2026-01-31T23:59:59Z'));
    });

    it('rejects invalid outcome enum values', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/authorize-attempts?outcome=not-a-real-outcome',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      // Zod schema enforces the enum; Fastify returns 400 on validation failure.
      expect(response.statusCode).toBe(400);
    });
  });
});
