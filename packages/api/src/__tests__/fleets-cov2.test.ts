// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const FLEET_ID = 'flt_000000000001';
const DRIVER_ID = 'drv_000000000001';
const STATION_ID = 'sta_000000000001';
const PGR_ID = 'pgr_000000000001';

const mockFleetService = vi.hoisted(() => ({
  getFleet: vi.fn(),
  addDriverToFleet: vi.fn(),
  addStationToFleet: vi.fn(),
  searchAvailableVehicles: vi.fn(),
  getFleetPricingGroup: vi.fn(),
  addPricingGroupToFleet: vi.fn(),
}));

vi.mock('../services/fleet.service.js', () => mockFleetService);

const { selectResults, writeAudit, publishPricingChanged } = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  writeAudit: vi.fn().mockResolvedValue(undefined),
  publishPricingChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/database', () => {
  const buildChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where']) {
      chain[m] = vi.fn(() => chain);
    }
    chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
      Promise.resolve(selectResults.shift() ?? []).then(onFulfilled, onRejected);
    return chain;
  };
  return {
    db: { select: vi.fn(() => buildChain()) },
    drivers: { id: 'drivers.id' },
    chargingStations: { id: 'charging_stations.id' },
    pricingGroups: { id: 'pricing_groups.id' },
    fleetAuditLog: { name: 'fleetAuditLog' },
    pricingAssignmentAuditLog: { name: 'pricingAssignmentAuditLog' },
    writeAudit,
    pgErrorCode: (err: unknown) => (err as { code?: string }).code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
  };
});

vi.mock('../lib/pricing-events.js', () => ({ publishPricingChanged }));

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

import { registerAuth } from '../plugins/auth.js';
import { fleetRoutes } from '../routes/fleets.js';

const fkError = Object.assign(new Error('fk'), { code: '23503' });
const otherError = Object.assign(new Error('boom'), { code: '40001' });

describe('fleet membership routes - error paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(fleetRoutes);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    selectResults.length = 0;
    vi.resetAllMocks();
    writeAudit.mockResolvedValue(undefined);
    publishPricingChanged.mockResolvedValue(undefined);
    mockFleetService.getFleet.mockResolvedValue({ id: FLEET_ID });
  });

  describe('POST /fleets/:id/drivers', () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/fleets/${FLEET_ID}/drivers`,
        headers: auth,
        payload: { driverId: DRIVER_ID },
      });

    it('returns 404 FLEET_NOT_FOUND before checking the driver', async () => {
      mockFleetService.getFleet.mockResolvedValue(null);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
      expect(mockFleetService.addDriverToFleet).not.toHaveBeenCalled();
    });

    it('returns 404 DRIVER_NOT_FOUND when the driver does not exist', async () => {
      selectResults.push([]);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
      expect(mockFleetService.addDriverToFleet).not.toHaveBeenCalled();
    });

    it('maps a foreign key race on insert to 404 DRIVER_NOT_FOUND', async () => {
      selectResults.push([{ id: DRIVER_ID }]);
      mockFleetService.addDriverToFleet.mockRejectedValue(fkError);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('rethrows other insert errors as 500', async () => {
      selectResults.push([{ id: DRIVER_ID }]);
      mockFleetService.addDriverToFleet.mockRejectedValue(otherError);
      const res = await post();
      expect(res.statusCode).toBe(500);
    });

    it('returns 409 when the driver is already in the fleet', async () => {
      selectResults.push([{ id: DRIVER_ID }]);
      mockFleetService.addDriverToFleet.mockResolvedValue(null);
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Driver is already in this fleet',
        code: 'DRIVER_ALREADY_IN_FLEET',
      });
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('POST /fleets/:id/stations', () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/fleets/${FLEET_ID}/stations`,
        headers: auth,
        payload: { stationId: STATION_ID },
      });

    it('returns 404 FLEET_NOT_FOUND before checking the station', async () => {
      mockFleetService.getFleet.mockResolvedValue(null);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
      expect(mockFleetService.addStationToFleet).not.toHaveBeenCalled();
    });

    it('returns 404 STATION_NOT_FOUND when the station does not exist', async () => {
      selectResults.push([]);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(mockFleetService.addStationToFleet).not.toHaveBeenCalled();
    });

    it('maps a foreign key race on insert to 404 STATION_NOT_FOUND', async () => {
      selectResults.push([{ id: STATION_ID }]);
      mockFleetService.addStationToFleet.mockRejectedValue(fkError);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('rethrows other insert errors as 500', async () => {
      selectResults.push([{ id: STATION_ID }]);
      mockFleetService.addStationToFleet.mockRejectedValue(otherError);
      const res = await post();
      expect(res.statusCode).toBe(500);
    });

    it('returns 409 when the station is already in the fleet', async () => {
      selectResults.push([{ id: STATION_ID }]);
      mockFleetService.addStationToFleet.mockResolvedValue(null);
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Station is already in this fleet',
        code: 'STATION_ALREADY_IN_FLEET',
      });
    });
  });

  describe('GET /fleets/:id/vehicles/available', () => {
    it('passes search and limit to the service and returns its rows', async () => {
      const vehicle = {
        id: 'veh_000000000001',
        driverId: DRIVER_ID,
        driverName: 'Ada Lovelace',
        make: 'Tesla',
        model: 'Model 3',
        year: '2024',
        vin: null,
        licensePlate: 'EV-1',
      };
      mockFleetService.searchAvailableVehicles.mockResolvedValue([vehicle]);
      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${FLEET_ID}/vehicles/available?search=tes&limit=5`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([expect.objectContaining({ id: vehicle.id, make: 'Tesla' })]);
      expect(mockFleetService.searchAvailableVehicles).toHaveBeenCalledWith(FLEET_ID, 'tes', 5);
    });

    it('defaults search to empty and limit to 10', async () => {
      mockFleetService.searchAvailableVehicles.mockResolvedValue([]);
      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${FLEET_ID}/vehicles/available`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(mockFleetService.searchAvailableVehicles).toHaveBeenCalledWith(FLEET_ID, '', 10);
    });
  });

  describe('POST /fleets/:id/pricing-groups', () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/fleets/${FLEET_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PGR_ID },
      });

    it('returns 404 FLEET_NOT_FOUND when the fleet does not exist', async () => {
      mockFleetService.getFleet.mockResolvedValue(null);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
    });

    it('returns 404 PRICING_GROUP_NOT_FOUND when the group does not exist', async () => {
      selectResults.push([]);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Pricing group not found',
        code: 'PRICING_GROUP_NOT_FOUND',
      });
      expect(mockFleetService.addPricingGroupToFleet).not.toHaveBeenCalled();
    });

    it('maps a foreign key race on insert to 404 PRICING_GROUP_NOT_FOUND', async () => {
      selectResults.push([{ id: PGR_ID }]);
      mockFleetService.getFleetPricingGroup.mockResolvedValue(null);
      mockFleetService.addPricingGroupToFleet.mockRejectedValue(fkError);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });

    it('rethrows other insert errors as 500', async () => {
      selectResults.push([{ id: PGR_ID }]);
      mockFleetService.getFleetPricingGroup.mockResolvedValue(null);
      mockFleetService.addPricingGroupToFleet.mockRejectedValue(otherError);
      const res = await post();
      expect(res.statusCode).toBe(500);
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });
  });
});
