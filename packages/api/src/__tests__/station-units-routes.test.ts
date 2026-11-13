// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@evtivity/lib';

// The station unit routes: site scope (404 STATION_NOT_FOUND like an unknown
// station), the permissions, the body schemas and the service called in the
// caller's name.

const svc = vi.hoisted(() => ({
  listUnits: vi.fn(),
  createUnit: vi.fn(),
  updateUnit: vi.fn(),
  deleteUnit: vi.fn(),
  assignEvseUnit: vi.fn(),
}));

vi.mock('../services/station-unit.service.js', () => svc);
vi.mock('@evtivity/database', () => ({
  STATION_UNIT_NAME_MAX: 50,
  STATION_UNIT_SERIAL_MAX: 64,
  STATION_UNITS_MAX: 64,
}));
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);
vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

import { registerAuth } from '../plugins/auth.js';
import { stationUnitRoutes } from '../routes/station-units.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';
import {
  resetSiteAccessMock,
  setMockStationSites,
  setMockUserSiteIds,
} from './helpers/site-access-mock.js';

const STATION = 'sta_000000000001';
const UNIT = 'unt_000000000001';
const VIEW = {
  id: UNIT,
  stationId: STATION,
  name: 'Box 1',
  sortOrder: 0,
  serialNumber: null,
  ipAddress: null,
  evseIds: ['evs_000000000001'],
  evseNumbers: [1],
};

describe('station unit routes', () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof AppError) {
        await reply.status(error.statusCode).send({ error: error.message, code: error.code });
        return;
      }
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      await reply.status(status).send({ error: String(error), code: 'VALIDATION_ERROR' });
    });
    await registerAuth(app);
    stationUnitRoutes(app);
    await app.ready();
    auth = {
      authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSiteAccessMock();
    setMockStationSites({ [STATION]: 'sit_a' });
    setMockPermissions(['stations:write']);
  });

  it('lists the units of a station', async () => {
    svc.listUnits.mockResolvedValue([VIEW]);
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION}/units`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([VIEW]);
  });

  it('answers STATION_NOT_FOUND for a station outside the caller sites, before any read', async () => {
    setMockUserSiteIds(['sit_b']);
    for (const [method, url, payload] of [
      ['GET', `/stations/${STATION}/units`, undefined],
      ['POST', `/stations/${STATION}/units`, { name: 'Box 1' }],
      ['PATCH', `/stations/${STATION}/units/${UNIT}`, { name: 'Box 2' }],
      ['DELETE', `/stations/${STATION}/units/${UNIT}`, undefined],
      ['PUT', `/stations/${STATION}/evses/1/unit`, { unitId: UNIT }],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'STATION_NOT_FOUND' });
    }
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('needs stations:write for the writes and stations:read for the list', async () => {
    setMockPermissions(['stations:read']);
    svc.listUnits.mockResolvedValue([]);
    expect(
      (await app.inject({ method: 'GET', url: `/stations/${STATION}/units`, headers: auth }))
        .statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/units`,
      headers: auth,
      payload: { name: 'Box 1' },
    });
    expect(res.statusCode).toBe(403);
    expect(svc.createUnit).not.toHaveBeenCalled();
  });

  it('creates a unit with EVSE numbers and answers 201', async () => {
    svc.createUnit.mockResolvedValue(VIEW);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/units`,
      headers: auth,
      payload: { name: 'Box 1', evseIds: [1, 2] },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.createUnit).toHaveBeenCalledWith(
      STATION,
      { name: 'Box 1', evseIds: [1, 2] },
      expect.objectContaining({
        actor: expect.objectContaining({ actorUserId: 'usr_000000000001' }),
      }),
    );
  });

  it('refuses a name with a bidi override or a line break in the schema', async () => {
    for (const name of ['Box‮1', 'Box\n1', 'Box​1']) {
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION}/units`,
        headers: auth,
        payload: { name },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(svc.createUnit).not.toHaveBeenCalled();
  });

  it('passes the serial number and IP address to the service, null and empty included', async () => {
    svc.createUnit.mockResolvedValue({ ...VIEW, serialNumber: 'SN1', ipAddress: '10.0.0.5' });
    const created = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/units`,
      headers: auth,
      payload: { name: 'Box 1', serialNumber: 'SN1', ipAddress: '10.0.0.5' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ serialNumber: 'SN1', ipAddress: '10.0.0.5' });
    expect(svc.createUnit).toHaveBeenCalledWith(
      STATION,
      { name: 'Box 1', serialNumber: 'SN1', ipAddress: '10.0.0.5' },
      expect.anything(),
    );
    svc.updateUnit.mockResolvedValue({ ...VIEW, serialNumber: null, ipAddress: null });
    const updated = await app.inject({
      method: 'PATCH',
      url: `/stations/${STATION}/units/${UNIT}`,
      headers: auth,
      payload: { serialNumber: '', ipAddress: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(svc.updateUnit).toHaveBeenCalledWith(
      STATION,
      UNIT,
      { serialNumber: '', ipAddress: null },
      expect.anything(),
    );
  });

  it('refuses a serial number with a control or invisible character in the schema', async () => {
    for (const serialNumber of ['SN\n1', 'SN\u202e1', 'SN\u200b1']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${STATION}/units/${UNIT}`,
        headers: auth,
        payload: { serialNumber },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(svc.updateUnit).not.toHaveBeenCalled();
  });

  it('passes the service errors through', async () => {
    svc.updateUnit.mockRejectedValue(
      new AppError('Another unit of this station has this name', 409, 'STATION_UNIT_NAME_IN_USE'),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/stations/${STATION}/units/${UNIT}`,
      headers: auth,
      payload: { name: 'Box 2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'STATION_UNIT_NAME_IN_USE' });
  });

  it('moves an EVSE into a unit, out of it with null, and refuses a bad unit id', async () => {
    svc.assignEvseUnit.mockResolvedValue({ changed: true });
    const res = await app.inject({
      method: 'PUT',
      url: `/stations/${STATION}/evses/2/unit`,
      headers: auth,
      payload: { unitId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: true });
    expect(svc.assignEvseUnit).toHaveBeenCalledWith(STATION, 2, null, expect.anything());
    const bad = await app.inject({
      method: 'PUT',
      url: `/stations/${STATION}/evses/2/unit`,
      headers: auth,
      payload: { unitId: 'sta_000000000002' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('deletes a unit', async () => {
    svc.deleteUnit.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'DELETE',
      url: `/stations/${STATION}/units/${UNIT}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
  });
});
