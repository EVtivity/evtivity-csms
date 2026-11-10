// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  enabled: vi.fn<() => Promise<boolean>>(),
  read: vi.fn(),
  authorized: [] as string[],
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  settings: {},
  sites: {},
  chargingStations: {},
  cssStations: {},
  effectiveDataPlanSql: 'effective_plan',
  isOperatorStation: vi.fn(),
  getOcppFleetHealth: vi.fn(),
  isCsmsUpdateCheckEnabled: state.enabled,
  readCsmsUpdateCheck: state.read,
}));

vi.mock('../lib/settings-crypto.js', () => ({ storedSecretDecrypts: () => false }));
vi.mock('../lib/payments.js', () => ({ activePaymentProvider: vi.fn() }));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (permission: string) =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      state.authorized.push(permission);
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { systemRoutes } from '../routes/system.js';
import { APP_VERSION } from '../lib/app-version.js';

describe('GET /system/update-check', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    systemRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.enabled.mockReset().mockResolvedValue(true);
    state.read.mockReset().mockResolvedValue(null);
    state.authorized.length = 0;
  });

  function get(auth = true): Promise<{ statusCode: number; json: () => unknown }> {
    return app.inject({
      method: 'GET',
      url: '/system/update-check',
      headers: auth ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it('returns the latest version the worker stored, for users:write holders', async () => {
    state.read.mockResolvedValue({
      latestVersion: '0.1.51',
      checkedAt: new Date('2026-11-10T03:41:00Z'),
      attemptedAt: new Date('2026-11-10T03:41:00Z'),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      currentVersion: APP_VERSION,
      latestVersion: '0.1.51',
      checkedAt: '2026-11-10T03:41:00.000Z',
    });
    expect(state.authorized).toContain('users:write');
  });

  it('answers no version before the first read', async () => {
    const res = await get();
    expect(res.json()).toMatchObject({ enabled: true, latestVersion: null, checkedAt: null });
  });

  it('answers no version and reads nothing while the update check is off', async () => {
    state.enabled.mockResolvedValue(false);
    state.read.mockResolvedValue({
      latestVersion: '0.1.51',
      checkedAt: new Date(),
      attemptedAt: new Date(),
    });
    const res = await get();
    expect(res.json()).toMatchObject({ enabled: false, latestVersion: null, checkedAt: null });
    expect(state.read).not.toHaveBeenCalled();
  });

  it('refuses a request without a session', async () => {
    const res = await get(false);
    expect(res.statusCode).toBe(401);
  });
});
