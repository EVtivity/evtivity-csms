// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';
import { sessionRoutes } from '../routes/sessions.js';
import { transactionRoutes } from '../routes/transactions.js';
import { fleetRoutes } from '../routes/fleets.js';
import { tokenRoutes } from '../routes/tokens.js';
import { driverRoutes } from '../routes/drivers.js';
import { pricingRoutes } from '../routes/pricing.js';

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

const VALID_STATION_ID = 'sta_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';
const VALID_FLEET_ID = 'flt_000000000001';
const VALID_TOKEN_ID = 'dtk_000000000001';
const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_PG_ID = 'pgr_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  return app;
}

async function buildFullApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.register(stationRoutes);
  await app.register(sessionRoutes);
  await app.register(transactionRoutes);
  await app.register(fleetRoutes);
  await app.register(tokenRoutes);
  await app.register(driverRoutes);
  await app.register(pricingRoutes);
  await app.ready();
  return app;
}

describe('Route registration', () => {
  it('registers station routes without error', async () => {
    const app = await buildApp();
    await app.register(stationRoutes);
    await app.ready();
    await app.close();
  });

  it('registers session routes without error', async () => {
    const app = await buildApp();
    await app.register(sessionRoutes);
    await app.ready();
    await app.close();
  });

  it('registers transaction routes without error', async () => {
    const app = await buildApp();
    await app.register(transactionRoutes);
    await app.ready();
    await app.close();
  });

  it('registers fleet routes without error', async () => {
    const app = await buildApp();
    await app.register(fleetRoutes);
    await app.ready();
    await app.close();
  });

  it('registers token routes without error', async () => {
    const app = await buildApp();
    await app.register(tokenRoutes);
    await app.ready();
    await app.close();
  });

  it('registers driver routes without error', async () => {
    const app = await buildApp();
    await app.register(driverRoutes);
    await app.ready();
    await app.close();
  });

  it('registers pricing routes without error', async () => {
    const app = await buildApp();
    await app.register(pricingRoutes);
    await app.ready();
    await app.close();
  });

  it('registers all route groups together without error', async () => {
    const app = await buildFullApp();
    await app.close();
  });
});

describe('Auth requirements - returns 401 without token', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildFullApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // Stations
  it('GET /v1/stations returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/stations' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/stations/:id returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/stations/' + VALID_STATION_ID });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/stations',
      payload: { stationId: 'test-station' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/stations/:id returns 401', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/stations/' + VALID_STATION_ID,
      payload: { model: 'updated' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/stations/:id returns 401', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/stations/' + VALID_STATION_ID,
    });
    expect(response.statusCode).toBe(401);
  });

  // Sessions
  it('GET /v1/sessions returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/sessions/:id returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions/' + VALID_SESSION_ID });
    expect(response.statusCode).toBe(401);
  });

  // Transactions
  it('GET /v1/transactions returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/transactions' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/transactions/by-session/:sessionId returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/transactions/by-session/' + VALID_SESSION_ID,
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/transactions/by-transaction-id/:transactionId returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/transactions/by-transaction-id/txn-123',
    });
    expect(response.statusCode).toBe(401);
  });

  // Fleets
  it('GET /v1/fleets returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/fleets' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/fleets/:id returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/fleets/' + VALID_FLEET_ID });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/fleets returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/fleets',
      payload: { name: 'Test Fleet' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/fleets/:id returns 401', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/fleets/' + VALID_FLEET_ID,
      payload: { name: 'Updated' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/fleets/:id returns 401', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/fleets/' + VALID_FLEET_ID });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/fleets/:id/drivers returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/fleets/' + VALID_FLEET_ID + '/drivers',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/fleets/:id/drivers returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/fleets/' + VALID_FLEET_ID + '/drivers',
      payload: { driverId: VALID_DRIVER_ID },
    });
    expect(response.statusCode).toBe(401);
  });

  // Tokens
  it('GET /v1/tokens returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/tokens' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/tokens/:id returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/tokens/' + VALID_TOKEN_ID });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/tokens returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tokens',
      payload: { driverId: VALID_DRIVER_ID, idToken: 'abc', tokenType: 'rfid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/tokens/:id returns 401', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/tokens/' + VALID_TOKEN_ID,
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/tokens/:id returns 401', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/tokens/' + VALID_TOKEN_ID });
    expect(response.statusCode).toBe(401);
  });

  // Drivers
  it('GET /v1/drivers returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/drivers' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/drivers/:id returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/drivers/' + VALID_DRIVER_ID });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/drivers returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/drivers',
      payload: { firstName: 'Jane', lastName: 'Doe' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/drivers/:id/tokens returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/drivers/' + VALID_DRIVER_ID + '/tokens',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/drivers/:id/tokens returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/drivers/' + VALID_DRIVER_ID + '/tokens',
      payload: { idToken: 'abc', tokenType: 'rfid' },
    });
    expect(response.statusCode).toBe(401);
  });

  // Pricing
  it('GET /v1/pricing-groups returns 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/pricing-groups' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/pricing-groups returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pricing-groups',
      payload: { name: 'Standard' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/pricing-groups/:id/tariffs returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/pricing-groups/' + VALID_PG_ID + '/tariffs',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/pricing-groups/:id/tariffs returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pricing-groups/' + VALID_PG_ID + '/tariffs',
      payload: { name: 'Peak', currency: 'USD' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('404 for unknown routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildFullApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 for GET /v1/nonexistent', async () => {
    const response = await app.inject({ method: 'GET', url: '/nonexistent' });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for POST /v1/nonexistent', async () => {
    const response = await app.inject({ method: 'POST', url: '/nonexistent' });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for DELETE /v1/nonexistent', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/nonexistent' });
    expect(response.statusCode).toBe(404);
  });
});

describe('Auth plugin decorators', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('decorates app with authenticate function', () => {
    expect(app).toHaveProperty('authenticate');
    expect(typeof app.authenticate).toBe('function');
  });

  it('decorates app with jwt', () => {
    expect(app).toHaveProperty('jwt');
  });

  it('jwt.sign produces a token string', () => {
    const token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('Schema validation with signed token', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildFullApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/stations without token returns 401 before validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/stations',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations with token and empty body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/stations',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/fleets with token and empty body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/fleets',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/tokens with token and empty body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/drivers with token and empty body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/drivers',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/pricing-groups with token and empty body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pricing-groups',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH /v1/stations/:id with token and invalid availability returns 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/stations/' + VALID_STATION_ID,
      headers: { authorization: 'Bearer ' + token },
      payload: { availability: 'invalid-status-value' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH /v1/tokens/:id with token and non-boolean isActive returns 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/tokens/' + VALID_TOKEN_ID,
      headers: { authorization: 'Bearer ' + token },
      payload: { isActive: 'not-a-boolean' },
    });
    expect(response.statusCode).toBe(400);
  });
});
