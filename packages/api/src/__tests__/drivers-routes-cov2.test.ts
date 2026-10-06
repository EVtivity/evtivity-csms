// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Each awaited query takes the next queued result. An Error rejects the query.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[]) {
  dbResults = results;
  dbCallIndex = 0;
}
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  const methods = [
    'select',
    'selectDistinct',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
  chains.push({ kind, chain });
  return chain;
}

function pgError(code: string): Error {
  return Object.assign(new Error('pg error'), { cause: { code } });
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    selectDistinct: vi.fn(() => makeChain('selectDistinct')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  },
  pgErrorCode: (err: unknown) => {
    const e = err as { cause?: { code?: string }; code?: string } | null;
    return e?.cause?.code ?? e?.code;
  },
  PG_UNIQUE_VIOLATION: '23505',
  PG_FOREIGN_KEY_VIOLATION: '23503',
  drivers: {},
  driverTokens: {},
  vehicles: {},
  vehicleEfficiencyLookup: {},
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  pricingGroupDrivers: {},
  pricingGroups: {},
  reservations: {},
  writeAudit: vi.fn().mockResolvedValue(undefined),
  driverAuditLog: { name: 'driverAuditLog' },
  vehicleAuditLog: { name: 'vehicleAuditLog' },
  pricingAssignmentAuditLog: { name: 'pricingAssignmentAuditLog' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/services/company-currency', () => ({
  sessionCurrencySql: vi.fn(() => 'currency'),
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
}));

const { publishPricingChangedMock, pricingGroupExistsMock, createTokenMock, bulkSetActiveMock } =
  vi.hoisted(() => ({
    publishPricingChangedMock: vi.fn(),
    pricingGroupExistsMock: vi.fn(),
    createTokenMock: vi.fn(),
    bulkSetActiveMock: vi.fn(),
  }));

vi.mock('../lib/pricing-events.js', () => ({ publishPricingChanged: publishPricingChangedMock }));
vi.mock('../lib/pricing-group-lookup.js', () => ({ pricingGroupExists: pricingGroupExistsMock }));

vi.mock('../services/token.service.js', () => {
  class DuplicateTokenError extends Error {}
  return { createToken: createTokenMock, bulkSetActive: bulkSetActiveMock, DuplicateTokenError };
});

vi.mock('../services/driver-portal-access.service.js', () => ({
  getPortalAccess: vi.fn(),
  inviteDriverToPortal: vi.fn(),
}));

vi.mock('../routes/tokens.js', () => ({ OCPP_TOKEN_TYPES: ['ISO14443', 'ISO15693', 'Central'] }));

import { writeAudit } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { driverRoutes } from '../routes/drivers.js';
import * as tokenService from '../services/token.service.js';

const DRIVER_ID = 'drv_000000000001';
const VEHICLE_ID = 'veh_000000000001';
const PG_ID = 'pgr_000000000001';
const now = new Date().toISOString();

function lastChain(kind: string): Chain | undefined {
  return chains.filter((c) => c.kind === kind).at(-1)?.chain;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  driverRoutes(app);
  await app.ready();
  return app;
}

describe('Driver routes (operator), uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'r' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    chains.length = 0;
    publishPricingChangedMock.mockResolvedValue(undefined);
    bulkSetActiveMock.mockResolvedValue(undefined);
  });

  describe('GET /drivers status filter', () => {
    it('returns the rows and total for status=inactive', async () => {
      const row = { id: DRIVER_ID, firstName: 'A', lastName: 'B', email: null, phone: null };
      setupDbResults(
        [{ ...row, language: 'en', isActive: false, createdAt: now, updatedAt: now }],
        [{ count: 7 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/drivers?status=inactive',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(7);
      expect(res.json().data[0].isActive).toBe(false);
    });

    it('rejects an unknown status value', async () => {
      const res = await app.inject({ method: 'GET', url: '/drivers?status=gone', headers: auth });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /drivers', () => {
    it('lowercases the email and returns 409 when it is already used', async () => {
      setupDbResults([{ id: 'drv_000000000009' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/drivers',
        headers: auth,
        payload: { firstName: 'A', lastName: 'B', email: 'Taken@Example.com' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
    });

    it('maps a unique violation on insert (email race) to 409', async () => {
      setupDbResults([], pgError('23505'));
      const res = await app.inject({
        method: 'POST',
        url: '/drivers',
        headers: auth,
        payload: { firstName: 'A', lastName: 'B', email: 'race@example.com' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_EMAIL');
      expect(lastChain('insert')?.['values']).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'race@example.com' }),
      );
    });

    it('rethrows other insert errors as 500', async () => {
      setupDbResults(pgError('XX000'));
      const res = await app.inject({
        method: 'POST',
        url: '/drivers',
        headers: auth,
        payload: { firstName: 'A', lastName: 'B' },
      });
      expect(res.statusCode).toBe(500);
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /drivers/:id', () => {
    it('rejects an invalid IANA timezone before touching the database', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { timezone: 'Mars/Olympus' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
      expect(chains).toHaveLength(0);
    });

    it('returns 409 when another driver has the email', async () => {
      setupDbResults([{ id: 'drv_000000000002' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: 'Other@Example.com' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_EMAIL');
    });

    it('maps a unique violation on update to 409', async () => {
      setupDbResults([], [{ id: DRIVER_ID }], pgError('23505'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: 'x@example.com' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_EMAIL');
    });

    it('rethrows other update errors as 500', async () => {
      setupDbResults([{ id: DRIVER_ID }], pgError('XX000'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { firstName: 'Z' },
      });
      expect(res.statusCode).toBe(500);
    });

    it('stores the timezone and audits a deactivation', async () => {
      const before = { id: DRIVER_ID, isActive: true };
      const updated = {
        id: DRIVER_ID,
        firstName: 'A',
        lastName: 'B',
        email: null,
        phone: null,
        language: 'en',
        isActive: false,
        createdAt: now,
        updatedAt: now,
      };
      setupDbResults([before], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { isActive: false, timezone: 'Europe/Berlin' },
      });
      expect(res.statusCode).toBe(200);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false, timezone: 'Europe/Berlin' }),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({ action: 'deactivated', before, after: updated }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('audits an activation of an inactive driver', async () => {
      const updated = {
        id: DRIVER_ID,
        firstName: 'A',
        lastName: 'B',
        email: null,
        phone: null,
        language: 'en',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      setupDbResults([{ id: DRIVER_ID, isActive: false }], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'activated' }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('POST /drivers/:id/tokens', () => {
    it('returns 409 TOKEN_DUPLICATE when the token is already registered', async () => {
      createTokenMock.mockRejectedValueOnce(
        new tokenService.DuplicateTokenError('RFID-1', 'ISO14443'),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/tokens`,
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
      expect(createTokenMock).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, idToken: 'RFID-1', tokenType: 'ISO14443' },
        { type: 'operator', userId: 'usr_000000000001' },
      );
    });

    it('returns 500 for other token service errors', async () => {
      createTokenMock.mockRejectedValueOnce(new Error('boom'));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/tokens`,
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /drivers/:id/vehicles', () => {
    it('returns 404 when the driver does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/vehicles`,
        headers: auth,
        payload: { make: 'Tesla', model: 'Model Y' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('maps a foreign key violation (driver deleted meanwhile) to 404', async () => {
      setupDbResults([{ id: DRIVER_ID }], pgError('23503'));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/vehicles`,
        headers: auth,
        payload: { make: 'Tesla', model: 'Model Y' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('returns 500 for other insert errors', async () => {
      setupDbResults([{ id: DRIVER_ID }], pgError('XX000'));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/vehicles`,
        headers: auth,
        payload: { make: 'Tesla', model: 'Model Y' },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('PATCH /drivers/:id/vehicles/:vehicleId', () => {
    it('sets only the given fields and audits before and after', async () => {
      const before = { id: VEHICLE_ID, driverId: DRIVER_ID, vin: 'OLD' };
      const updated = {
        id: VEHICLE_ID,
        driverId: DRIVER_ID,
        make: 'BMW',
        model: 'i4',
        year: '2023',
        vin: 'NEWVIN',
        licensePlate: 'XY1',
        createdAt: now,
        updatedAt: now,
      };
      setupDbResults([before], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}/vehicles/${VEHICLE_ID}`,
        headers: auth,
        payload: { make: 'BMW', model: 'i4', year: '2023', vin: 'NEWVIN', licensePlate: 'XY1' },
      });
      expect(res.statusCode).toBe(200);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({
          make: 'BMW',
          model: 'i4',
          year: '2023',
          vin: 'NEWVIN',
          licensePlate: 'XY1',
        }),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'vehicle_id' }),
        expect.objectContaining({ action: 'updated', before, after: updated }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('GET /vehicles/lookup', () => {
    it('filters models by make when make is given', async () => {
      setupDbResults([{ make: 'BMW' }, { make: 'Tesla' }], [{ make: 'Tesla', model: 'Model 3' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/vehicles/lookup?make=tesla',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        makes: ['BMW', 'Tesla'],
        models: [{ make: 'Tesla', model: 'Model 3' }],
      });
      const modelChain = chains.filter((c) => c.kind === 'selectDistinct')[1]?.chain;
      expect(modelChain?.['where']).toHaveBeenCalled();
    });

    it('returns every model when make is blank', async () => {
      setupDbResults(
        [{ make: 'Tesla' }],
        [
          { make: 'Tesla', model: 'Model 3' },
          { make: 'Tesla', model: 'Model Y' },
        ],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/vehicles/lookup?make=%20',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().models).toHaveLength(2);
      const modelChain = chains.filter((c) => c.kind === 'selectDistinct')[1]?.chain;
      expect(modelChain?.['where']).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /drivers/:id', () => {
    it('deactivates every token the driver owns', async () => {
      const driver = { id: DRIVER_ID, isActive: true };
      setupDbResults([driver], [], [{ id: 'dtk_000000000001' }, { id: 'dtk_000000000002' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(bulkSetActiveMock).toHaveBeenCalledWith(
        ['dtk_000000000001', 'dtk_000000000002'],
        false,
        { type: 'operator', userId: 'usr_000000000001' },
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'deleted', before: driver }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('GET /drivers/:id/sessions', () => {
    it('returns 404 when the driver does not exist', async () => {
      setupDbResults([], [], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/sessions`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns the page of sessions and the total', async () => {
      const session = {
        id: 'ses_000000000001',
        stationId: 'sta_000000000001',
        stationName: 'CS-1',
        siteName: 'Site',
        driverId: DRIVER_ID,
        driverName: 'A B',
        transactionId: 'tx-1',
        status: 'completed',
        startedAt: now,
        endedAt: now,
        energyDeliveredWh: '1000',
        currentCostCents: 100,
        finalCostCents: 120,
        currency: 'EUR',
      };
      setupDbResults([{ id: DRIVER_ID }], [session], [{ count: 31 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/sessions?page=2&limit=10`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(31);
      expect(res.json().data[0]).toMatchObject({ id: 'ses_000000000001', currency: 'EUR' });
      const dataChain = chains.filter((c) => c.kind === 'select')[1]?.chain;
      expect(dataChain?.['offset']).toHaveBeenCalledWith(10);
      expect(dataChain?.['limit']).toHaveBeenCalledWith(10);
    });

    it('returns total 0 when the count row is missing', async () => {
      setupDbResults([{ id: DRIVER_ID }], [], []);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/sessions`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /drivers/:id/reservations', () => {
    it('returns 404 when the driver does not exist', async () => {
      setupDbResults([], [], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/reservations`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns the reservations with cancel metadata', async () => {
      const row = {
        id: 'rsv_000000000001',
        reservationId: 42,
        stationId: 'sta_000000000001',
        stationOcppId: 'CS-1',
        siteName: null,
        status: 'cancelled',
        startsAt: now,
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
        cancelledBy: 'operator',
        cancelReason: 'other',
        cancelNote: 'site closed',
        cancellationFeeCents: 0,
      };
      setupDbResults([{ id: DRIVER_ID }], [row], [{ count: 1 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/reservations`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(1);
      expect(res.json().data[0]).toMatchObject({ reservationId: 42, cancelNote: 'site closed' });
    });

    it('returns total 0 when the count row is missing', async () => {
      setupDbResults([{ id: DRIVER_ID }], [], []);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/reservations`,
        headers: auth,
      });
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /drivers/:id/pricing-groups', () => {
    it('returns the assigned pricing group', async () => {
      const group = {
        id: PG_ID,
        name: 'Fleet',
        description: null,
        isDefault: false,
        tariffCount: 2,
      };
      setupDbResults([group]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(group);
    });

    it('returns null when no group is assigned', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('null');
    });
  });

  describe('POST /drivers/:id/pricing-groups', () => {
    const record = { id: 1, driverId: DRIVER_ID, pricingGroupId: PG_ID, createdAt: now };

    it('returns 404 when the pricing group does not exist', async () => {
      pricingGroupExistsMock.mockResolvedValueOnce(false);
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PG_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(publishPricingChangedMock).not.toHaveBeenCalled();
    });

    it('creates the assignment, audits it and publishes the change', async () => {
      pricingGroupExistsMock.mockResolvedValueOnce(true);
      setupDbResults([], [record]);
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PG_ID },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ driverId: DRIVER_ID, pricingGroupId: PG_ID });
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'pricing_assignment_id' }),
        expect.objectContaining({
          action: 'created',
          before: null,
          after: { scope: 'driver', driverId: DRIVER_ID, pricingGroupId: PG_ID },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(publishPricingChangedMock).toHaveBeenCalledWith({
        pricingGroupId: PG_ID,
        action: 'assignment.changed',
        driverId: DRIVER_ID,
      });
    });

    it('audits an update with the previous pricing group', async () => {
      pricingGroupExistsMock.mockResolvedValueOnce(true);
      setupDbResults([{ driverId: DRIVER_ID, pricingGroupId: 'pgr_000000000099' }], [record]);
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PG_ID },
      });
      expect(res.statusCode).toBe(201);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'pricing_assignment_id' }),
        expect.objectContaining({
          action: 'updated',
          before: { scope: 'driver', driverId: DRIVER_ID, pricingGroupId: 'pgr_000000000099' },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          action: 'pricing_assignment_changed',
          before: { pricingGroupId: 'pgr_000000000099' },
          after: { pricingGroupId: PG_ID },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('maps a foreign key violation on insert to 404', async () => {
      pricingGroupExistsMock.mockResolvedValueOnce(true);
      setupDbResults([], pgError('23503'));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PG_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('returns 500 for other insert errors', async () => {
      pricingGroupExistsMock.mockResolvedValueOnce(true);
      setupDbResults([], pgError('XX000'));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: PG_ID },
      });
      expect(res.statusCode).toBe(500);
    });

    it('rejects a malformed pricing group id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/pricing-groups`,
        headers: auth,
        payload: { pricingGroupId: 'nope' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /drivers/:id/pricing-groups/:pricingGroupId', () => {
    it('returns 404 when the driver has no such assignment', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}/pricing-groups/${PG_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Pricing group not found for driver',
        code: 'PRICING_ASSIGNMENT_NOT_FOUND',
      });
    });

    it('removes the assignment, audits it and publishes the change', async () => {
      const record = { id: 1, driverId: DRIVER_ID, pricingGroupId: PG_ID, createdAt: now };
      setupDbResults([record]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}/pricing-groups/${PG_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ driverId: DRIVER_ID, pricingGroupId: PG_ID });
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'pricing_assignment_id' }),
        expect.objectContaining({
          action: 'deleted',
          before: { scope: 'driver', driverId: DRIVER_ID, pricingGroupId: PG_ID },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(publishPricingChangedMock).toHaveBeenCalledWith({
        pricingGroupId: PG_ID,
        action: 'assignment.changed',
        driverId: DRIVER_ID,
      });
    });
  });
});
