// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// POST /v1/sessions/:id/vehicle-claim: the route checks the session's site and
// driver, then stores the captured id through the vehicle service.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const m = vi.hoisted(() => ({
  claimSessionVehicleId: vi.fn(),
  getUserSiteIds: vi.fn(),
  rows: [] as unknown[][],
  authorizeCalls: [] as string[],
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'limit']) c[k] = () => c;
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(m.rows.shift() ?? []).then(resolve, reject);
    return c;
  };
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    db: { select: vi.fn(() => chain()) },
  };
});
vi.mock('../services/vehicle.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/vehicle.service.js')>()),
  claimSessionVehicleId: m.claimSessionVehicleId,
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: m.getUserSiteIds,
  invalidateSiteAccessCache: vi.fn(),
}));
vi.mock('../middleware/rbac.js', () => ({
  requestHasPermission: vi.fn(() => true),
  authorize: (permission: string) => {
    m.authorizeCalls.push(permission);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    };
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { sessionRoutes } from '../routes/sessions.js';
import { SessionNotFoundError, VehicleNotFoundError } from '../services/vehicle.service.js';

const SESSION = 'ses_000000000001';
const VEHICLE = 'veh_000000000001';
const DRIVER = 'drv_000000000001';
const SITE = 'sit_000000000001';

describe('POST /sessions/:id/vehicle-claim', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    sessionRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    m.rows = [];
    m.getUserSiteIds.mockReset().mockResolvedValue([SITE]);
    m.claimSessionVehicleId.mockReset();
  });

  const claim = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/vehicle-claim`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it('needs drivers:write and stores the id on an existing vehicle of the driver', async () => {
    expect(m.authorizeCalls).toContain('drivers:write');
    m.rows.push([{ driverId: DRIVER, siteId: SITE }]);
    m.claimSessionVehicleId.mockResolvedValueOnce({
      vehicle: { id: VEHICLE, autochargeEnabled: true },
      created: false,
    });
    const res = await claim({ vehicleId: VEHICLE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vehicleId: VEHICLE, created: false, autochargeEnabled: true });
    expect(m.claimSessionVehicleId).toHaveBeenCalledWith(
      {
        sessionId: SESSION,
        driverId: DRIVER,
        target: { vehicleId: VEHICLE },
        enableAutocharge: true,
      },
      expect.objectContaining({ actor: 'operator' }),
      expect.anything(),
    );
  });

  it('creates a new vehicle with Autocharge off when asked', async () => {
    m.rows.push([{ driverId: DRIVER, siteId: SITE }]);
    m.claimSessionVehicleId.mockResolvedValueOnce({
      vehicle: { id: VEHICLE, autochargeEnabled: false },
      created: true,
    });
    const res = await claim({
      vehicle: { make: 'Volvo', model: 'EX30' },
      enableAutocharge: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: true, autochargeEnabled: false });
    expect(m.claimSessionVehicleId.mock.calls[0]?.[0]).toMatchObject({
      target: { vehicle: { make: 'Volvo', model: 'EX30' } },
      enableAutocharge: false,
    });
  });

  it('answers 404 for a missing session and a session at another site', async () => {
    const missing = await claim({ vehicleId: VEHICLE });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('SESSION_NOT_FOUND');
    m.rows.push([{ driverId: DRIVER, siteId: 'sit_000000000999' }]);
    const foreign = await claim({ vehicleId: VEHICLE });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('SESSION_NOT_FOUND');
    expect(m.claimSessionVehicleId).not.toHaveBeenCalled();
  });

  it('answers 404 DRIVER_NOT_FOUND for a session without a driver', async () => {
    m.rows.push([{ driverId: null, siteId: SITE }]);
    const res = await claim({ vehicleId: VEHICLE });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    expect(m.claimSessionVehicleId).not.toHaveBeenCalled();
  });

  it('refuses a body with both a vehicle id and a new vehicle', async () => {
    const res = await claim({ vehicleId: VEHICLE, vehicle: { make: 'A', model: 'B' } });
    expect(res.statusCode).toBe(400);
    expect(m.claimSessionVehicleId).not.toHaveBeenCalled();
  });

  it('answers the vehicle service errors with their codes and rethrows others', async () => {
    const cases: [Error, number, string | undefined][] = [
      [new VehicleNotFoundError(), 404, 'VEHICLE_NOT_FOUND'],
      [new SessionNotFoundError(), 404, 'SESSION_NOT_FOUND'],
      [new Error('database down'), 500, undefined],
    ];
    for (const [err, status, code] of cases) {
      m.rows.push([{ driverId: DRIVER, siteId: SITE }]);
      m.claimSessionVehicleId.mockRejectedValueOnce(err);
      const res = await claim({ vehicleId: VEHICLE });
      expect(res.statusCode).toBe(status);
      if (code != null) expect(res.json().code).toBe(code);
    }
  });
});
