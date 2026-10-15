// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
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
    'for',
    'onConflictDoNothing',
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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  ACCOUNT_INVOICE_RECIPIENTS: ['fleet', 'member'],
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

// Vehicle writes go through the vehicle service (vehicle-service-mapping is
// checked here; the service itself runs against the database in
// __integration__/118-autocharge-vehicles).
const vehicleServiceMock = vi.hoisted(() => ({
  createVehicle: vi.fn(),
  updateVehicle: vi.fn(),
  deleteVehicle: vi.fn(),
  setVehicleBlocked: vi.fn(),
}));
vi.mock('../services/vehicle.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/vehicle.service.js')>()),
  ...vehicleServiceMock,
}));
vi.mock('../lib/vehicle-response.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vehicle-response.js')>()),
  vehicleLastSeen: vi.fn(() => Promise.resolve(new Map())),
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
  class TokenDriverNotFoundError extends Error {}
  class TokenDriverInactiveError extends Error {}
  class PncContractTokenError extends Error {}
  return {
    createToken: createTokenMock,
    bulkSetActive: bulkSetActiveMock,
    DuplicateTokenError,
    TokenDriverNotFoundError,
    TokenDriverInactiveError,
    PncContractTokenError,
    tokenActorOf: (actor: { actorUserId: string | null }) => ({
      type: 'operator',
      userId: actor.actorUserId,
    }),
  };
});

vi.mock('../services/driver-portal-access.service.js', () => ({
  getPortalAccess: vi.fn(),
  inviteDriverToPortal: vi.fn(),
}));

const { applyDriverDeactivationMock, revokeDriverEmailLinksMock } = vi.hoisted(() => ({
  applyDriverDeactivationMock: vi.fn(),
  revokeDriverEmailLinksMock: vi.fn(),
}));
const { eraseDriverMock } = vi.hoisted(() => ({ eraseDriverMock: vi.fn() }));
vi.mock('../services/driver-erasure.service.js', () => ({ eraseDriver: eraseDriverMock }));

const { sendDriverEmailVerificationMock } = vi.hoisted(() => ({
  sendDriverEmailVerificationMock: vi.fn(),
}));
vi.mock('../lib/driver-email-verification.js', () => ({
  sendDriverEmailVerification: sendDriverEmailVerificationMock,
}));

vi.mock('../services/driver-status.service.js', () => ({
  applyDriverDeactivation: applyDriverDeactivationMock,
  revokeDriverEmailLinks: revokeDriverEmailLinksMock,
}));

import { inOperatorStation, writeAudit } from '@evtivity/database';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';
import { registerAuth } from '../plugins/auth.js';
import { driverRoutes } from '../routes/drivers.js';
import * as tokenService from '../services/token.service.js';

const DRIVER_ID = 'drv_000000000001';
const VEHICLE_ID = 'veh_000000000001';
const PG_ID = 'pgr_000000000001';
const now = new Date().toISOString();

// The full driver row PATCH reads first (email and phone guards, audit diff).
const BEFORE_ROW = {
  id: DRIVER_ID,
  firstName: 'A',
  lastName: 'B',
  email: 'a@example.com',
  phone: null,
  language: 'en',
  timezone: 'America/New_York',
  isActive: true,
  passwordHash: null,
  mfaEnabled: false,
  mfaMethod: null,
};

// The safe projection PATCH returns.
const UPDATED_ROW = {
  id: DRIVER_ID,
  firstName: 'A',
  lastName: 'B',
  email: 'a@example.com',
  phone: null,
  language: 'en',
  timezone: 'America/New_York',
  isActive: true,
  createdAt: now,
  updatedAt: now,
};

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
    applyDriverDeactivationMock.mockResolvedValue({ tokensDeactivated: 0 });
    revokeDriverEmailLinksMock.mockResolvedValue(undefined);
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

    it('returns 404 before any write when the driver does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { firstName: 'Z' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
      expect(chains.filter((c) => c.kind === 'update')).toHaveLength(0);
    });

    it('returns 409 when another driver has the email', async () => {
      setupDbResults([BEFORE_ROW], [{ id: 'drv_000000000002' }]);
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
      setupDbResults([BEFORE_ROW], [], pgError('23505'));
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
      setupDbResults([BEFORE_ROW], pgError('XX000'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { firstName: 'Z' },
      });
      expect(res.statusCode).toBe(500);
    });

    it('stores the timezone, audits the changed fields and applies the deactivation', async () => {
      const before = { ...BEFORE_ROW, isActive: true };
      const updated = { ...UPDATED_ROW, isActive: false, timezone: 'Europe/Berlin' };
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
        expect.objectContaining({
          action: 'deactivated',
          before: { isActive: true, timezone: 'America/New_York' },
          after: { isActive: false, timezone: 'Europe/Berlin' },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(applyDriverDeactivationMock).toHaveBeenCalledWith(
        DRIVER_ID,
        expect.objectContaining({
          actor: expect.objectContaining({ actorUserId: 'usr_000000000001' }),
        }),
      );
      expect(revokeDriverEmailLinksMock).not.toHaveBeenCalled();
    });

    it('applies the deactivation again for a driver already inactive, without an audit row', async () => {
      const before = { ...BEFORE_ROW, isActive: false };
      setupDbResults([before], [{ ...UPDATED_ROW, isActive: false }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);
      expect(applyDriverDeactivationMock).toHaveBeenCalledWith(DRIVER_ID, expect.anything());
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('writes no audit row when nothing changed', async () => {
      setupDbResults([BEFORE_ROW], [UPDATED_ROW]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { firstName: 'A' },
      });
      expect(res.statusCode).toBe(200);
      expect(writeAudit).not.toHaveBeenCalled();
      expect(applyDriverDeactivationMock).not.toHaveBeenCalled();
    });

    it('revokes the emailed links when the email changes', async () => {
      setupDbResults([BEFORE_ROW], [], [{ ...UPDATED_ROW, email: 'new@example.com' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: 'New@Example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@example.com' }),
      );
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false }),
      );
      expect(revokeDriverEmailLinksMock).toHaveBeenCalledWith(DRIVER_ID);
      // No portal access: the invitation verifies the address, no link is sent now.
      expect(sendDriverEmailVerificationMock).not.toHaveBeenCalled();
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'updated',
          before: { email: 'a@example.com' },
          after: { email: 'new@example.com' },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('emails a verification link to the new address of a driver with portal access', async () => {
      setupDbResults(
        [{ ...BEFORE_ROW, passwordHash: '$argon2id$x', emailVerified: true }],
        [],
        [{ ...UPDATED_ROW, email: 'new@example.com', emailVerified: false }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: 'new@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(sendDriverEmailVerificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: DRIVER_ID, email: 'new@example.com', firstName: 'A' }),
        expect.anything(),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          before: { email: 'a@example.com', emailVerified: true },
          after: { email: 'new@example.com', emailVerified: false },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('keeps the emailed links when the email only changes case', async () => {
      setupDbResults([BEFORE_ROW], [], [UPDATED_ROW]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: 'A@Example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(revokeDriverEmailLinksMock).not.toHaveBeenCalled();
      expect(lastChain('update')?.['set']).not.toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false }),
      );
      expect(sendDriverEmailVerificationMock).not.toHaveBeenCalled();
    });

    it('removes the phone with null or an empty string', async () => {
      setupDbResults([{ ...BEFORE_ROW, phone: '+15550001' }], [UPDATED_ROW]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { phone: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null }),
      );
    });

    it('refuses to remove the email of a driver with portal access', async () => {
      setupDbResults([{ ...BEFORE_ROW, passwordHash: '$argon2id$x' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: null },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(chains.filter((c) => c.kind === 'update')).toHaveLength(0);
    });

    it('removes the email of a driver without portal access and revokes the links', async () => {
      setupDbResults([BEFORE_ROW], [{ ...UPDATED_ROW, email: null }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { email: null },
      });
      expect(res.statusCode).toBe(200);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ email: null }),
      );
      expect(revokeDriverEmailLinksMock).toHaveBeenCalledWith(DRIVER_ID);
    });

    it('refuses to remove the phone of a driver signing in with SMS codes', async () => {
      setupDbResults([{ ...BEFORE_ROW, phone: '+15550001', mfaEnabled: true, mfaMethod: 'sms' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { phone: null },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects an empty first name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { firstName: '' },
      });
      expect(res.statusCode).toBe(400);
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
      setupDbResults(
        [{ ...BEFORE_ROW, isActive: false }],
        [{ ...updated, timezone: 'America/New_York' }],
      );
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
    it('returns 404 when the token service finds no driver', async () => {
      createTokenMock.mockRejectedValueOnce(new tokenService.TokenDriverNotFoundError(DRIVER_ID));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/tokens`,
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
    });

    it('refuses a token for an inactive driver', async () => {
      createTokenMock.mockRejectedValueOnce(new tokenService.TokenDriverInactiveError(DRIVER_ID));
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/tokens`,
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Driver is inactive', code: 'DRIVER_INACTIVE' });
    });

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
      // The service maps the violation to VehicleDriverNotFoundError.
      const { VehicleDriverNotFoundError } = await import('../services/vehicle.service.js');
      setupDbResults([{ id: DRIVER_ID }]);
      vehicleServiceMock.createVehicle.mockRejectedValueOnce(new VehicleDriverNotFoundError());
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
      setupDbResults([{ id: DRIVER_ID }]);
      vehicleServiceMock.createVehicle.mockRejectedValueOnce(pgError('XX000'));
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
    it('passes null removals and the new id fields to the vehicle service', async () => {
      const updated = {
        id: VEHICLE_ID,
        driverId: DRIVER_ID,
        make: 'BMW',
        model: 'i4',
        year: null,
        vin: null,
        licensePlate: null,
        evccid: '92D50A693F80',
        autochargeEnabled: true,
        autochargeBlockedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      vehicleServiceMock.updateVehicle.mockResolvedValueOnce(updated);
      const payload = {
        year: null,
        vin: null,
        licensePlate: null,
        evccid: '92:d5:0a:69:3f:80',
        autochargeEnabled: true,
      };
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}/vehicles/${VEHICLE_ID}`,
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ evccid: '92D50A693F80', autochargeEnabled: true });
      expect(vehicleServiceMock.updateVehicle).toHaveBeenCalledWith(
        DRIVER_ID,
        VEHICLE_ID,
        payload,
        expect.anything(),
        expect.anything(),
      );
    });

    it('answers a bad VIN with 400 VALIDATION_ERROR', async () => {
      const { VehicleIdInvalidError } = await import('../services/vehicle.service.js');
      vehicleServiceMock.updateVehicle.mockRejectedValueOnce(new VehicleIdInvalidError('vin'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}/vehicles/${VEHICLE_ID}`,
        headers: auth,
        payload: { vin: 'NOT-A-VIN' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'vin' } });
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

  describe('POST /drivers/:id/erase', () => {
    afterEach(() => {
      resetSiteAccessMock();
    });

    it('refuses a confirmation that does not repeat the driver id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/erase`,
        headers: auth,
        payload: { confirm: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(eraseDriverMock).not.toHaveBeenCalled();
    });

    it('answers 404 to a site-restricted user before anything else', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/erase`,
        headers: auth,
        payload: { confirm: DRIVER_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
      expect(eraseDriverMock).not.toHaveBeenCalled();
    });

    it('erases the driver as the operator and returns the counts', async () => {
      eraseDriverMock.mockResolvedValueOnce({
        erasedAt: new Date(now),
        paymentMethodsRemoved: 1,
        vehiclesRemoved: 2,
        tokensDeactivated: 3,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${DRIVER_ID}/erase`,
        headers: auth,
        payload: { confirm: DRIVER_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        paymentMethodsRemoved: 1,
        vehiclesRemoved: 2,
        tokensDeactivated: 3,
      });
      expect(eraseDriverMock).toHaveBeenCalledWith(
        DRIVER_ID,
        expect.objectContaining({
          actor: expect.objectContaining({ actorUserId: 'usr_000000000001' }),
        }),
      );
    });
  });

  describe('PATCH /drivers/:id on an erased driver', () => {
    it('answers 409 DRIVER_ERASED and writes nothing', async () => {
      setupDbResults([{ ...BEFORE_ROW, erasedAt: new Date(), isActive: false }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DRIVER_ERASED');
      expect(chains.filter((c) => c.kind === 'update')).toHaveLength(0);
    });
  });

  describe('DELETE /drivers/:id', () => {
    it('deactivates the driver, applies the deactivation and audits the delete', async () => {
      setupDbResults([{ ...BEFORE_ROW, isActive: true }], [{ id: DRIVER_ID }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(lastChain('update')?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
      expect(applyDriverDeactivationMock).toHaveBeenCalledWith(
        DRIVER_ID,
        expect.objectContaining({
          actor: expect.objectContaining({ actor: 'operator', actorUserId: 'usr_000000000001' }),
        }),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'deleted',
          before: expect.objectContaining({ isActive: true, email: 'a@example.com' }),
          after: { isActive: false },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('repeated on an inactive driver: still applies the deactivation, no second audit row', async () => {
      setupDbResults([{ ...BEFORE_ROW, isActive: false }], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(applyDriverDeactivationMock).toHaveBeenCalledWith(DRIVER_ID, expect.anything());
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown driver', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${DRIVER_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(applyDriverDeactivationMock).not.toHaveBeenCalled();
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
      vi.mocked(inOperatorStation).mockClear();
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
      // Sessions of conformance test stations are never listed.
      expect(vi.mocked(inOperatorStation)).toHaveBeenCalledTimes(1);
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
      vi.mocked(inOperatorStation).mockClear();
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${DRIVER_ID}/reservations`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(1);
      expect(res.json().data[0]).toMatchObject({ reservationId: 42, cancelNote: 'site closed' });
      // Reservations of conformance test stations are never listed.
      expect(vi.mocked(inOperatorStation)).toHaveBeenCalledTimes(1);
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
