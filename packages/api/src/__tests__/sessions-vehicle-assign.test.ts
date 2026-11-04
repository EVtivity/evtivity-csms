// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PUT /v1/sessions/:id/vehicle: the route passes the caller's sites to the
// vehicle service and answers its errors with their codes.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const m = vi.hoisted(() => ({
  assignSessionVehicle: vi.fn(),
  getUserSiteIds: vi.fn(),
  authorizeCalls: [] as string[],
}));

vi.mock('../services/vehicle.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/vehicle.service.js')>()),
  assignSessionVehicle: m.assignSessionVehicle,
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
import {
  SessionNotActiveError,
  SessionNotFoundError,
  VehicleNotFoundError,
} from '../services/vehicle.service.js';

const SESSION = 'ses_000000000001';
const VEHICLE = 'veh_000000000001';

describe('PUT /sessions/:id/vehicle', () => {
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
    m.getUserSiteIds.mockReset().mockResolvedValue(['sit_000000000001']);
    m.assignSessionVehicle.mockReset();
  });

  const put = (vehicleId: string) =>
    app.inject({
      method: 'PUT',
      url: `/sessions/${SESSION}/vehicle`,
      headers: { authorization: `Bearer ${token}` },
      payload: { vehicleId },
    });

  it('needs sessions:write and passes the caller sites', async () => {
    expect(m.authorizeCalls).toContain('sessions:write');
    m.assignSessionVehicle.mockResolvedValueOnce({
      sessionId: SESSION,
      vehicleId: VEHICLE,
      previousVehicleId: null,
      changed: true,
    });
    const res = await put(VEHICLE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vehicleId: VEHICLE, changed: true });
    expect(m.assignSessionVehicle).toHaveBeenCalledWith(
      { sessionId: SESSION, vehicleId: VEHICLE, siteScope: ['sit_000000000001'] },
      expect.objectContaining({ actor: 'operator' }),
      expect.anything(),
    );
  });

  it('answers the service errors with their codes', async () => {
    const cases: [Error, number, string][] = [
      [new SessionNotFoundError(), 404, 'SESSION_NOT_FOUND'],
      [new VehicleNotFoundError(), 404, 'VEHICLE_NOT_FOUND'],
      [new SessionNotActiveError(), 409, 'SESSION_NOT_ACTIVE'],
    ];
    for (const [err, status, code] of cases) {
      m.assignSessionVehicle.mockRejectedValueOnce(err);
      const res = await put(VEHICLE);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    }
  });

  it('refuses a body without a vehicle id', async () => {
    const res = await put('drv_000000000001');
    expect(res.statusCode).toBe(400);
    expect(m.assignSessionVehicle).not.toHaveBeenCalled();
  });
});
