// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Record<string, unknown> {
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
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  client: vi.fn(),
  maintenanceEvents: { id: 'id', siteId: 'siteId', status: 'status', plannedStartAt: 'p' },
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
    model: 'model',
    siteId: 'siteId',
    isOnline: 'isOnline',
  },
  chargingSessions: {
    id: 'id',
    stationId: 'stationId',
    transactionId: 'tx',
    driverId: 'd',
    status: 'status',
  },
  reservations: {
    id: 'id',
    stationId: 'stationId',
    startsAt: 's',
    expiresAt: 'e',
    driverId: 'd',
    status: 'status',
  },
  drivers: { id: 'id', firstName: 'f', lastName: 'l' },
  sites: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  gt: vi.fn(),
  gte: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/station-derived-status.js', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'DERIVED_STATUS_SQL'),
}));

vi.mock('../services/maintenance.service.js', () => ({
  createEvent: vi.fn(),
  cancelEvent: vi.fn(),
  updateEvent: vi.fn(),
  addStationsToMaintenance: vi.fn(),
  removeStationsFromMaintenance: vi.fn(),
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
import { maintenanceRoutes } from '../routes/maintenance.js';

const VALID_SITE_ID = 'sit_000000000001';
const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  maintenanceRoutes(app);
  await app.ready();
  return app;
}

describe('Maintenance station-preview route', () => {
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
    setupDbResults();
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/maintenance/station-preview?startAt=2026-01-01T00:00:00Z&endAt=2026-01-01T02:00:00Z`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('includes derived status on each preview row', async () => {
    // stations query, then Promise.all([activeSessions, overlapReservations]).
    // No drivers present, so the conditional driver query never runs.
    setupDbResults(
      [
        {
          id: VALID_STATION_ID,
          stationId: 'CS-0001',
          model: 'TestModel',
          status: 'charging',
          isOnline: true,
        },
      ],
      [],
      [],
    );
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/maintenance/station-preview?startAt=2026-01-01T00:00:00Z&endAt=2026-01-01T02:00:00Z`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.['status']).toBe('charging');
    expect(body[0]?.['hasActiveSession']).toBe(false);
    expect(body[0]?.['upcomingReservationCount']).toBe(0);
  });
});
