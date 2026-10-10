// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

const STATION_ID = 'sta_000000000001';

const { checkStationSiteAccess, checkWebPaymentSupport, requestHasPermission, authorizeCalls } =
  vi.hoisted(() => ({
    checkStationSiteAccess: vi.fn(),
    checkWebPaymentSupport: vi.fn(),
    requestHasPermission: vi.fn(),
    authorizeCalls: [] as string[],
  }));

vi.mock('@evtivity/database', () => ({ db: {} }));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess,
}));

vi.mock('../services/web-payment.service.js', () => ({
  checkWebPaymentSupport,
  disableWebPayments: vi.fn(),
  enableWebPayments: vi.fn(),
  getWebPaymentConfig: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize: (permission: string) => {
    authorizeCalls.push(permission);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    };
  },
  requestHasPermission,
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { stationWebPaymentRoutes } from '../routes/station-web-payments.js';

const SUPPORTED = {
  status: 'supported',
  reason: 'reported',
  source: 'station',
  stationEnabled: false,
  checkedAt: '2026-10-09T12:00:00.000Z',
};

describe('GET /stations/:id/web-payments/support', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
    await app.register(stationWebPaymentRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'role_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    checkStationSiteAccess.mockResolvedValue(true);
    checkWebPaymentSupport.mockResolvedValue(SUPPORTED);
    requestHasPermission.mockResolvedValue(true);
  });

  it('is guarded by stations:read', () => {
    expect(authorizeCalls).toContain('stations:read');
  });

  it('returns 401 without a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers from the stored device model by default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SUPPORTED);
    expect(checkWebPaymentSupport).toHaveBeenCalledWith(
      STATION_ID,
      expect.objectContaining({ live: false }),
    );
  });

  it('asks the station with live=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support?live=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(checkWebPaymentSupport).toHaveBeenCalledWith(
      STATION_ID,
      expect.objectContaining({ live: true }),
    );
  });

  it('returns 404 for a station outside the user sites', async () => {
    checkStationSiteAccess.mockResolvedValue(false);
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support?live=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'STATION_NOT_FOUND' });
    expect(checkWebPaymentSupport).not.toHaveBeenCalled();
  });

  it('needs stations:write for live=true, which sends an OCPP command', async () => {
    requestHasPermission.mockResolvedValue(false);
    const live = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support?live=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.statusCode).toBe(403);
    expect(live.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(requestHasPermission).toHaveBeenCalledWith(expect.anything(), 'stations:write');
    expect(checkWebPaymentSupport).not.toHaveBeenCalled();

    const stored = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stored.statusCode).toBe(200);
  });

  it('limits live checks to 10 per minute per user, not stored answers', async () => {
    const other = app.jwt.sign({ userId: 'usr_rate', roleId: 'role_1' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/stations/${STATION_ID}/web-payments/support?live=true`,
        headers: { authorization: `Bearer ${other}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    const stored = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(stored.statusCode).toBe(200);

    const otherUser = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support?live=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(otherUser.statusCode).toBe(200);
  });

  it('rejects an invalid live value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/web-payments/support?live=yes`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
