// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const STATION_ID = 'sta_000000000001';

const { checkStationSiteAccess, getWebPaymentConfig, enableWebPayments, disableWebPayments } =
  vi.hoisted(() => ({
    checkStationSiteAccess: vi.fn(),
    getWebPaymentConfig: vi.fn(),
    enableWebPayments: vi.fn(),
    disableWebPayments: vi.fn(),
  }));

vi.mock('@evtivity/database', () => ({ db: {} }));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess,
}));
vi.mock('../services/web-payment.service.js', () => ({
  checkWebPaymentSupport: vi.fn(),
  disableWebPayments,
  enableWebPayments,
  getWebPaymentConfig,
}));
vi.mock('../lib/audit-actor.js', () => ({
  getAuditActor: () => ({ actorType: 'user', actorId: 'usr_1' }),
}));
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
  requestHasPermission: vi.fn().mockResolvedValue(true),
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { stationWebPaymentRoutes } from '../routes/station-web-payments.js';

const ENABLED = {
  enabled: true,
  validitySeconds: 60,
  totpLength: 8,
  totpVersion: 'v1',
  urlTemplate: 'https://portal.example/qr',
};
const DISABLED = {
  enabled: false,
  validitySeconds: null,
  totpLength: null,
  totpVersion: null,
  urlTemplate: null,
};

describe('station web payment config routes', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(stationWebPaymentRoutes);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'role_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    checkStationSiteAccess.mockResolvedValue(true);
    getWebPaymentConfig.mockResolvedValue(DISABLED);
    enableWebPayments.mockResolvedValue(ENABLED);
    disableWebPayments.mockResolvedValue(DISABLED);
  });

  it('GET returns the stored configuration of a station in scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DISABLED);
    expect(checkStationSiteAccess).toHaveBeenCalledWith(STATION_ID, 'usr_1');
    expect(getWebPaymentConfig).toHaveBeenCalledWith(STATION_ID);
  });

  it('GET, PUT and DELETE answer 404 for a station out of scope and change nothing', async () => {
    checkStationSiteAccess.mockResolvedValue(false);
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/stations/${STATION_ID}/web-payments`,
        headers: auth,
        ...(method === 'PUT' ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'STATION_NOT_FOUND' });
    }
    expect(getWebPaymentConfig).not.toHaveBeenCalled();
    expect(enableWebPayments).not.toHaveBeenCalled();
    expect(disableWebPayments).not.toHaveBeenCalled();
  });

  it('PUT enables with the defaults and the caller as actor', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/stations/${STATION_ID}/web-payments`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ENABLED);
    expect(enableWebPayments).toHaveBeenCalledWith(
      STATION_ID,
      { validitySeconds: 60, totpLength: 8 },
      expect.objectContaining({ actor: { actorType: 'user', actorId: 'usr_1' } }),
    );
  });

  it('PUT passes the sent values and refuses values out of range', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: `/stations/${STATION_ID}/web-payments`,
      headers: auth,
      payload: { validitySeconds: 120, totpLength: 12 },
    });
    expect(ok.statusCode).toBe(200);
    expect(enableWebPayments).toHaveBeenCalledWith(
      STATION_ID,
      { validitySeconds: 120, totpLength: 12 },
      expect.anything(),
    );
    const bad = await app.inject({
      method: 'PUT',
      url: `/stations/${STATION_ID}/web-payments`,
      headers: auth,
      payload: { validitySeconds: 5 },
    });
    expect(bad.statusCode).toBe(400);
    expect(enableWebPayments).toHaveBeenCalledTimes(1);
  });

  it('DELETE disables with the caller as actor', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/stations/${STATION_ID}/web-payments`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DISABLED);
    expect(disableWebPayments).toHaveBeenCalledWith(
      STATION_ID,
      expect.objectContaining({ actor: { actorType: 'user', actorId: 'usr_1' } }),
    );
  });

  it('refuses a request without a token', async () => {
    const res = await app.inject({ method: 'GET', url: `/stations/${STATION_ID}/web-payments` });
    expect(res.statusCode).toBe(401);
  });
});
