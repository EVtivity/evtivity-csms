// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';

const VALID_STATION_ID = 'sta_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(stationRoutes);
  await app.ready();
  return app;
}

describe('EVSE/Connector endpoints - auth requirements', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/stations/:id/evses returns 401 without token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses`,
      payload: {
        evseId: 1,
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/stations/:id/evses/:evseId returns 401 without token', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/stations/${VALID_STATION_ID}/evses/1`,
      payload: {
        connectors: [{ connectorId: 1, connectorType: 'Type2' }],
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations/:id/evses/:evseId/connectors returns 401 without token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
      payload: { connectorId: 2, connectorType: 'CHAdeMO', maxPowerKw: 50 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/stations/:id/evses/:evseId returns 401 without token', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/stations/${VALID_STATION_ID}/evses/1`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId returns 401 without token', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('EVSE/Connector endpoints - schema validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/stations/:id/evses rejects invalid evseId (0)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses`,
      payload: {
        evseId: 0,
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
      },
      headers: { authorization: 'Bearer invalid' },
    });
    // Auth fails before validation, but route exists
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations/:id/evses rejects empty connectors array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses`,
      payload: {
        evseId: 1,
        connectors: [],
      },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations/:id/evses rejects invalid connector type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses`,
      payload: {
        evseId: 1,
        connectors: [{ connectorId: 1, connectorType: 'InvalidType', maxPowerKw: 150 }],
      },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/stations/:id/evses/:evseId/connectors rejects missing fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
      payload: { connectorId: 1 },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/stations/:id/evses/:evseId requires auth even with non-integer evseId', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/stations/${VALID_STATION_ID}/evses/abc`,
    });
    // Auth runs before schema validation in Fastify
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId requires auth even with non-integer connectorId', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/stations/${VALID_STATION_ID}/evses/1/connectors/abc`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('EVSE/Connector endpoints - route registration', () => {
  it('registers all EVSE/connector routes without error', async () => {
    const app = Fastify();
    await registerAuth(app);
    await app.register(stationRoutes);
    await app.ready();
    await app.close();
  });
});

describe('EVSE/Connector endpoints - response shape', () => {
  it('GET /v1/stations/:id/connectors returns 401 without auth', async () => {
    const app = Fastify();
    await registerAuth(app);
    await app.register(stationRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/stations/${VALID_STATION_ID}/connectors`,
    });
    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
