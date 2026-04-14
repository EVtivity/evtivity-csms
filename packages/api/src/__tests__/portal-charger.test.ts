// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';
const VALID_RESERVATION_ID = 'rsv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

describe('Portal charger routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers without error', async () => {
    const freshApp = Fastify();
    await registerAuth(freshApp);
    await freshApp.register(portalChargerRoutes);
    await freshApp.ready();
    await freshApp.close();
  });

  describe('GET /v1/portal/chargers/sessions/active', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /v1/portal/chargers/sessions/:sessionId/stop', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /v1/portal/reservations', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/reservations',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /v1/portal/reservations', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /v1/portal/reservations/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
