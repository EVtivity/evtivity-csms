// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_FLEET_ID = 'flt_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_SECONDARY_ID = 'drv_000000000001';

// The fleet billing profile every fleet row carries (fleetItem response).
const BILLING_PROFILE = {
  billingContactEmails: [] as string[],
  billingLegalName: null,
  billingStreet: null,
  billingCity: null,
  billingState: null,
  billingZip: null,
  billingCountry: null,
  billingTaxId: null,
  invoiceLanguage: 'en',
  paymentTermsDays: null,
  autoInvoice: false,
};

// Mock the fleet service - use vi.hoisted so the object is available when vi.mock is hoisted
const mockFleetService = vi.hoisted(() => ({
  listFleets: vi.fn(),
  getFleet: vi.fn(),
  createFleet: vi.fn(),
  updateFleet: vi.fn(),
  deleteFleet: vi.fn(),
  getFleetDrivers: vi.fn(),
  addDriverToFleet: vi.fn(),
  removeDriverFromFleet: vi.fn(),
  getFleetStations: vi.fn(),
  addStationToFleet: vi.fn(),
  removeStationFromFleet: vi.fn(),
  getFleetVehicles: vi.fn(),
  getFleetSessions: vi.fn(),
  getFleetMetrics: vi.fn(),
  getFleetEnergyHistory: vi.fn(),
  getFleetPricingGroup: vi.fn(),
  addPricingGroupToFleet: vi.fn(),
  removePricingGroupFromFleet: vi.fn(),
  setFleetAccountBilling: vi.fn(),
  updateFleetBillingProfile: vi.fn(),
  getFleetCreditLimit: vi.fn(),
  setFleetCreditLimit: vi.fn(),
  FleetBillingUpgradePendingError: class FleetBillingUpgradePendingError extends Error {
    readonly details: unknown;
    constructor(details: unknown) {
      super('A process older than v0.1.41 is still connected.');
      this.details = details;
    }
  },
  setMemberBillingOptOut: vi.fn(),
  notifyMemberJoined: vi.fn(),
  notifyMemberLeft: vi.fn(),
}));

vi.mock('../services/fleet.service.js', () => mockFleetService);

// Mock @evtivity/database so the FK pre-checks (POST drivers / stations /
// pricing-groups) find their target rows. Each pre-check does
// db.select(...).from(table).where(eq(table.id, ...)) and resolves with the
// returned array; mockResolvedValue provides a thenable matching that shape.
const mockDbResults = vi.hoisted(() => ({ findRow: true }));
vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'status'),
  buildStatusReasonSubquery: vi.fn(() => null),
}));

vi.mock('@evtivity/database', () => {
  const buildChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select',
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
      'onConflictDoNothing',
      'delete',
      'insert',
      'update',
    ];
    for (const m of methods) {
      chain[m] = vi.fn(() => chain);
    }
    chain['then'] = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => {
      // FK pre-checks expect a single-row [{id}] result; return a stub row
      // when findRow=true, empty array otherwise (covers the 404 path tests
      // that may be added later).
      const result = mockDbResults.findRow ? [{ id: 'mock-id' }] : [];
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };
    chain['catch'] = (onRejected?: (r: unknown) => unknown) =>
      Promise.resolve([]).catch(onRejected);
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => buildChain()),
      insert: vi.fn(() => buildChain()),
      update: vi.fn(() => buildChain()),
      delete: vi.fn(() => buildChain()),
    },
    drivers: {},
    chargingStations: {},
    pricingGroups: {},
    fleetAuditLog: {},
    pricingAssignmentAuditLog: {},
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(fleetRoutes);
  await app.ready();
  return app;
}

describe('Fleet routes - handler logic', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- GET /v1/fleets ---

  describe('GET /v1/fleets', () => {
    it('returns paginated fleet list', async () => {
      const fleetRow = {
        id: VALID_FLEET_ID,
        name: 'Fleet A',
        description: null,
        accountBillingEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        driverCount: 3,
        stationCount: 2,
      };
      mockFleetService.listFleets.mockResolvedValue({ data: [fleetRow], total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: '/fleets',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Fleet A');
    });

    it('returns empty data when no fleets exist', async () => {
      mockFleetService.listFleets.mockResolvedValue({ data: [], total: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/fleets',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('passes search query to service', async () => {
      mockFleetService.listFleets.mockResolvedValue({ data: [], total: 0 });

      await app.inject({
        method: 'GET',
        url: '/fleets?search=test',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(mockFleetService.listFleets).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'test' }),
      );
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/fleets',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/fleets/:id ---

  describe('GET /v1/fleets/:id', () => {
    it('returns a fleet when found', async () => {
      const fleet = {
        id: VALID_FLEET_ID,
        name: 'Fleet A',
        description: 'A fleet',
        accountBillingEnabled: false,
        ...BILLING_PROFILE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFleetService.getFleet.mockResolvedValue(fleet);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Fleet A');
    });

    it('returns 404 when fleet not found', async () => {
      mockFleetService.getFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('returns 400 for invalid id param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/fleets/not-a-nanoid',
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- POST /v1/fleets ---

  describe('POST /v1/fleets', () => {
    it('creates a fleet and returns 201', async () => {
      const created = {
        id: VALID_FLEET_ID,
        name: 'New Fleet',
        description: 'Desc',
        accountBillingEnabled: false,
        ...BILLING_PROFILE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFleetService.createFleet.mockResolvedValue(created);

      const response = await app.inject({
        method: 'POST',
        url: '/fleets',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Fleet', description: 'Desc' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('New Fleet');
    });

    it('creates a fleet without description', async () => {
      const created = {
        id: VALID_FLEET_ID,
        name: 'Minimal Fleet',
        description: null,
        accountBillingEnabled: false,
        ...BILLING_PROFILE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFleetService.createFleet.mockResolvedValue(created);

      const response = await app.inject({
        method: 'POST',
        url: '/fleets',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Minimal Fleet' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('Minimal Fleet');
    });

    it('returns 400 for missing name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fleets',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fleets',
        payload: { name: 'Fleet' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- PATCH /v1/fleets/:id ---

  describe('PATCH /v1/fleets/:id', () => {
    it('updates and returns the fleet', async () => {
      const updated = {
        id: VALID_FLEET_ID,
        name: 'Updated Fleet',
        description: 'Updated',
        accountBillingEnabled: false,
        ...BILLING_PROFILE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFleetService.updateFleet.mockResolvedValue(updated);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Updated Fleet' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Updated Fleet');
    });

    it('returns 404 when fleet not found', async () => {
      mockFleetService.updateFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}`,
        payload: { name: 'X' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- DELETE /v1/fleets/:id ---

  describe('PATCH /v1/fleets/:id/billing', () => {
    const fleet = {
      id: VALID_FLEET_ID,
      name: 'Fleet A',
      description: null,
      accountBillingEnabled: true,
      ...BILLING_PROFILE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('turns account billing on through the fleet service', async () => {
      mockFleetService.setFleetAccountBilling.mockResolvedValue(fleet);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing`,
        headers: { authorization: 'Bearer ' + token },
        payload: { accountBillingEnabled: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().accountBillingEnabled).toBe(true);
      expect(mockFleetService.setFleetAccountBilling).toHaveBeenCalledWith(
        VALID_FLEET_ID,
        true,
        expect.objectContaining({ actor: expect.objectContaining({ actorUserId: VALID_USER_ID }) }),
      );
    });

    it('returns 404 for an unknown fleet', async () => {
      mockFleetService.setFleetAccountBilling.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing`,
        headers: { authorization: 'Bearer ' + token },
        payload: { accountBillingEnabled: false },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('answers 409 FLEET_BILLING_OLD_PODS_CONNECTED with the guard details', async () => {
      const details = { oldConnections: 1, hosts: [], lastOldSeenAt: null, watchCheckedAt: null };
      mockFleetService.setFleetAccountBilling.mockRejectedValue(
        new mockFleetService.FleetBillingUpgradePendingError(details),
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing`,
        headers: { authorization: 'Bearer ' + token },
        payload: { accountBillingEnabled: true },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'FLEET_BILLING_OLD_PODS_CONNECTED',
        details,
      });
    });

    it('rejects a body without the flag', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(mockFleetService.setFleetAccountBilling).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /v1/fleets/:id/billing-profile', () => {
    const fleet = {
      id: VALID_FLEET_ID,
      name: 'Fleet A',
      description: null,
      accountBillingEnabled: true,
      ...BILLING_PROFILE,
      billingContactEmails: ['ap@acme.example'],
      billingLegalName: 'Acme GmbH',
      billingTaxId: 'DE123456789',
      invoiceLanguage: 'de',
      paymentTermsDays: 14,
      autoInvoice: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('updates the profile through the fleet service', async () => {
      mockFleetService.updateFleetBillingProfile.mockResolvedValue(fleet);
      const payload = {
        billingContactEmails: ['ap@acme.example'],
        billingLegalName: 'Acme GmbH',
        billingTaxId: 'DE123456789',
        invoiceLanguage: 'de',
        paymentTermsDays: 14,
        autoInvoice: true,
      };

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing-profile`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(payload);
      expect(mockFleetService.updateFleetBillingProfile).toHaveBeenCalledWith(
        VALID_FLEET_ID,
        payload,
        expect.objectContaining({ actor: expect.objectContaining({ actorUserId: VALID_USER_ID }) }),
      );
    });

    it('answers 400 FLEET_BILLING_CONTACT_REQUIRED', async () => {
      const { AppError } = await import('@evtivity/lib');
      mockFleetService.updateFleetBillingProfile.mockRejectedValue(
        new AppError(
          'Automatic invoicing needs at least one billing contact.',
          400,
          'FLEET_BILLING_CONTACT_REQUIRED',
        ),
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing-profile`,
        headers: { authorization: 'Bearer ' + token },
        payload: { autoInvoice: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('FLEET_BILLING_CONTACT_REQUIRED');
    });

    it('returns 404 for an unknown fleet', async () => {
      mockFleetService.updateFleetBillingProfile.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing-profile`,
        headers: { authorization: 'Bearer ' + token },
        payload: { billingCity: 'Berlin' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it.each([
      ['an invalid email', { billingContactEmails: ['not-an-email'] }],
      [
        'too many contacts',
        { billingContactEmails: Array.from({ length: 11 }, (_, i) => `a${String(i)}@x.example`) },
      ],
      ['an unsupported language', { invoiceLanguage: 'fr' }],
      ['payment terms over 365 days', { paymentTermsDays: 366 }],
      ['negative payment terms', { paymentTermsDays: -1 }],
      ['a tax id over 50 characters', { billingTaxId: 'x'.repeat(51) }],
    ])('rejects %s', async (_label, payload) => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/billing-profile`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(mockFleetService.updateFleetBillingProfile).not.toHaveBeenCalled();
    });
  });

  describe('/v1/fleets/:id/credit-limit', () => {
    const view = {
      creditLimitCents: 100_000,
      warningPercent: 80,
      exposure: {
        unbilledCents: 50_000,
        invoicedCents: 30_000,
        runningCents: 2_500,
        totalCents: 82_500,
        currency: 'EUR',
      },
      level: 'warning',
    };

    it('returns the limit and the exposure', async () => {
      mockFleetService.getFleetCreditLimit.mockResolvedValue(view);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(view);
      expect(mockFleetService.getFleetCreditLimit).toHaveBeenCalledWith(VALID_FLEET_ID);
    });

    it('returns 404 for an unknown fleet', async () => {
      mockFleetService.getFleetCreditLimit.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('sets the limit and the warning percent through the fleet service', async () => {
      mockFleetService.setFleetCreditLimit.mockResolvedValue(view);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
        payload: { creditLimitCents: 100_000, warningPercent: 80 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().level).toBe('warning');
      expect(mockFleetService.setFleetCreditLimit).toHaveBeenCalledWith(
        VALID_FLEET_ID,
        { creditLimitCents: 100_000, warningPercent: 80 },
        expect.objectContaining({ actor: expect.objectContaining({ actorUserId: VALID_USER_ID }) }),
      );
    });

    it('removes the limit with null', async () => {
      mockFleetService.setFleetCreditLimit.mockResolvedValue({
        ...view,
        creditLimitCents: null,
        level: null,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
        payload: { creditLimitCents: null },
      });

      expect(response.statusCode).toBe(200);
      expect(mockFleetService.setFleetCreditLimit).toHaveBeenCalledWith(
        VALID_FLEET_ID,
        { creditLimitCents: null, warningPercent: undefined },
        expect.anything(),
      );
    });

    it.each([
      ['a zero limit', { creditLimitCents: 0 }],
      ['a negative limit', { creditLimitCents: -5 }],
      ['a fractional limit', { creditLimitCents: 10.5 }],
      ['a warning percent of 0', { warningPercent: 0 }],
      ['a warning percent of 100', { warningPercent: 100 }],
    ])('rejects %s', async (_name, payload) => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(mockFleetService.setFleetCreditLimit).not.toHaveBeenCalled();
    });

    it('returns 404 when setting the limit of an unknown fleet', async () => {
      mockFleetService.setFleetCreditLimit.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/credit-limit`,
        headers: { authorization: 'Bearer ' + token },
        payload: { warningPercent: 90 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /v1/fleets/:id/drivers/:driverId', () => {
    it("sets a member's opt-out through the fleet service", async () => {
      const record = {
        fleetId: VALID_FLEET_ID,
        driverId: 'drv_000000000001',
        accountBillingOptOut: true,
      };
      mockFleetService.setMemberBillingOptOut.mockResolvedValue(record);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/drivers/drv_000000000001`,
        headers: { authorization: 'Bearer ' + token },
        payload: { accountBillingOptOut: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().accountBillingOptOut).toBe(true);
      expect(mockFleetService.setMemberBillingOptOut).toHaveBeenCalledWith(
        VALID_FLEET_ID,
        'drv_000000000001',
        true,
        expect.anything(),
      );
    });

    it('returns 404 when the driver is not a member', async () => {
      mockFleetService.setMemberBillingOptOut.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/fleets/${VALID_FLEET_ID}/drivers/drv_000000000001`,
        headers: { authorization: 'Bearer ' + token },
        payload: { accountBillingOptOut: false },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });
  });

  describe('DELETE /v1/fleets/:id', () => {
    it('returns 409 FLEET_HAS_OPEN_BILLING while sessions are billed to the fleet', async () => {
      const { AppError } = await import('@evtivity/lib');
      mockFleetService.deleteFleet.mockRejectedValue(
        new AppError('The fleet has sessions billed to its account', 409, 'FLEET_HAS_OPEN_BILLING'),
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('FLEET_HAS_OPEN_BILLING');
    });

    it('deletes fleet and returns it', async () => {
      const fleet = {
        id: VALID_FLEET_ID,
        name: 'Deleted Fleet',
        description: null,
        accountBillingEnabled: false,
        ...BILLING_PROFILE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFleetService.deleteFleet.mockResolvedValue(fleet);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Deleted Fleet');
    });

    it('returns 404 when fleet not found', async () => {
      mockFleetService.deleteFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/fleets/:id/drivers ---

  describe('GET /v1/fleets/:id/drivers', () => {
    it('returns list of fleet drivers', async () => {
      const drivers = [
        {
          id: VALID_SECONDARY_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@test.com',
          phone: null,
          isActive: true,
          accountBillingOptOut: false,
          createdAt: new Date('2024-01-01'),
        },
      ];
      mockFleetService.getFleetDrivers.mockResolvedValue({ data: drivers, total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].firstName).toBe('John');
    });

    it('returns empty data when no drivers', async () => {
      mockFleetService.getFleetDrivers.mockResolvedValue({ data: [], total: 0 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- POST /v1/fleets/:id/drivers ---

  describe('POST /v1/fleets/:id/drivers', () => {
    it('adds driver to fleet and returns 201', async () => {
      const record = { fleetId: VALID_FLEET_ID, driverId: 'drv_000000000001' };
      mockFleetService.getFleet.mockResolvedValue({ id: VALID_FLEET_ID, name: 'Fleet 1' });
      mockFleetService.addDriverToFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
        headers: { authorization: 'Bearer ' + token },
        payload: { driverId: 'drv_000000000001' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().driverId).toBe('drv_000000000001');
    });

    it('returns 400 for missing driverId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid driverId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/drivers`,
        headers: { authorization: 'Bearer ' + token },
        payload: { driverId: 'not-a-nanoid' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- DELETE /v1/fleets/:id/drivers/:driverId ---

  describe('DELETE /v1/fleets/:id/drivers/:driverId', () => {
    it('removes driver from fleet', async () => {
      const record = { fleetId: VALID_FLEET_ID, driverId: 'drv_000000000001' };
      mockFleetService.removeDriverFromFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/drivers/drv_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().driverId).toBe('drv_000000000001');
      expect(mockFleetService.notifyMemberLeft).toHaveBeenCalledWith(record, expect.anything());
    });

    it('returns 404 when driver not found in fleet', async () => {
      mockFleetService.removeDriverFromFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/drivers/drv_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/drivers/drv_000000000001`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/fleets/:id/stations ---

  describe('GET /v1/fleets/:id/stations', () => {
    it('returns list of fleet stations', async () => {
      const stations = [
        {
          id: VALID_SECONDARY_ID,
          stationId: 'CS001',
          siteId: null,
          model: 'Model X',
          securityProfile: null,
          ocppProtocol: null,
          status: 'online',
          statusReason: null,
          connectorCount: 2,
          connectorTypes: ['CCS2'],
          isOnline: true,
          lastHeartbeat: null,
          createdAt: new Date('2026-01-15T10:00:00Z'),
        },
      ];
      mockFleetService.getFleetStations.mockResolvedValue(stations);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].stationId).toBe('CS001');
    });

    it('returns empty array when no stations', async () => {
      mockFleetService.getFleetStations.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  // --- POST /v1/fleets/:id/stations ---

  describe('POST /v1/fleets/:id/stations', () => {
    it('adds station to fleet and returns 201', async () => {
      const record = { fleetId: VALID_FLEET_ID, stationId: 'sta_000000000001' };
      mockFleetService.getFleet.mockResolvedValue({ id: VALID_FLEET_ID, name: 'Fleet 1' });
      mockFleetService.addStationToFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'sta_000000000001' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().stationId).toBe('sta_000000000001');
    });

    it('returns 400 for missing stationId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- DELETE /v1/fleets/:id/stations/:stationId ---

  describe('DELETE /v1/fleets/:id/stations/:stationId', () => {
    it('removes station from fleet', async () => {
      const record = { fleetId: VALID_FLEET_ID, stationId: 'sta_000000000001' };
      mockFleetService.removeStationFromFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/stations/sta_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().stationId).toBe('sta_000000000001');
    });

    it('returns 404 when station not found in fleet', async () => {
      mockFleetService.removeStationFromFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/stations/sta_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- GET /v1/fleets/:id/vehicles ---

  describe('GET /v1/fleets/:id/vehicles', () => {
    it('returns list of fleet vehicles', async () => {
      const vehicles = [
        {
          id: VALID_SECONDARY_ID,
          driverId: 'drv_000000000001',
          driverName: 'John Doe',
          make: 'Tesla',
          model: 'Model 3',
          year: '2023',
          vin: 'ABC123',
          licensePlate: 'XYZ',
        },
      ];
      mockFleetService.getFleetVehicles.mockResolvedValue({ data: vehicles, total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/vehicles`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].make).toBe('Tesla');
    });

    it('returns empty data when no vehicles', async () => {
      mockFleetService.getFleetVehicles.mockResolvedValue({ data: [], total: 0 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/vehicles`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // --- GET /v1/fleets/:id/sessions ---

  describe('GET /v1/fleets/:id/sessions', () => {
    it('returns paginated sessions', async () => {
      const sessionRow = {
        id: 'sess-1',
        stationId: 'CS001',
        stationName: null,
        siteName: null,
        transactionId: null,
        status: 'completed',
        startedAt: null,
        endedAt: null,
        idleStartedAt: null,
        energyDeliveredWh: 5000,
        currentCostCents: 0,
        finalCostCents: null,
        currency: null,
      };
      mockFleetService.getFleetSessions.mockResolvedValue({ data: [sessionRow], total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
    });

    it('passes page and limit to service', async () => {
      mockFleetService.getFleetSessions.mockResolvedValue({ data: [], total: 0 });

      await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/sessions?page=2&limit=5`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(mockFleetService.getFleetSessions).toHaveBeenCalledWith(VALID_FLEET_ID, 2, 5);
    });

    it('returns empty data when no sessions', async () => {
      mockFleetService.getFleetSessions.mockResolvedValue({ data: [], total: 0 });

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // --- GET /v1/fleets/:id/metrics ---

  describe('GET /v1/fleets/:id/metrics', () => {
    it('returns fleet metrics', async () => {
      const metrics = {
        totalSessions: 10,
        completedSessions: 8,
        faultedSessions: 1,
        sessionSuccessPercent: 80,
        totalEnergyWh: 50000,
        avgSessionDurationMinutes: 45,
        activeDrivers: 3,
        totalDrivers: 5,
        totalVehicles: 4,
        periodMonths: 12,
      };
      mockFleetService.getFleetMetrics.mockResolvedValue(metrics);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/metrics`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('totalSessions');
      expect(body).toHaveProperty('periodMonths');
      expect(body.totalSessions).toBe(10);
    });

    it('passes months query to service', async () => {
      mockFleetService.getFleetMetrics.mockResolvedValue({
        totalSessions: 0,
        completedSessions: 0,
        faultedSessions: 0,
        sessionSuccessPercent: 0,
        totalEnergyWh: 0,
        avgSessionDurationMinutes: 0,
        activeDrivers: 0,
        totalDrivers: 0,
        totalVehicles: 0,
        periodMonths: 6,
      });

      await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/metrics?months=6`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(mockFleetService.getFleetMetrics).toHaveBeenCalledWith(VALID_FLEET_ID, 6);
    });
  });

  // --- GET /v1/fleets/:id/energy-history ---

  describe('GET /v1/fleets/:id/energy-history', () => {
    it('returns energy history data', async () => {
      const rows = [
        { date: '2025-01-01', energyWh: 10000 },
        { date: '2025-01-02', energyWh: 15000 },
      ];
      mockFleetService.getFleetEnergyHistory.mockResolvedValue(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/energy-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0]).toHaveProperty('date');
      expect(body[0]).toHaveProperty('energyWh');
    });

    it('passes days query to service', async () => {
      mockFleetService.getFleetEnergyHistory.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/energy-history?days=30`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(mockFleetService.getFleetEnergyHistory).toHaveBeenCalledWith(VALID_FLEET_ID, 30);
    });
  });

  // --- GET /v1/fleets/:id/pricing-groups ---

  describe('GET /v1/fleets/:id/pricing-groups', () => {
    it('returns a single pricing group when one is assigned', async () => {
      const group = {
        id: VALID_SECONDARY_ID,
        name: 'Standard',
        description: 'Default',
        isDefault: true,
        tariffCount: 2,
      };
      mockFleetService.getFleetPricingGroup.mockResolvedValue(group);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe('Standard');
      expect(body.tariffCount).toBe(2);
    });

    it('returns null when no pricing group assigned', async () => {
      mockFleetService.getFleetPricingGroup.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toBeNull();
    });
  });

  // --- POST /v1/fleets/:id/pricing-groups ---

  describe('POST /v1/fleets/:id/pricing-groups', () => {
    it('adds pricing group to fleet and returns 201', async () => {
      const record = { fleetId: VALID_FLEET_ID, pricingGroupId: 'pgr_000000000001' };
      mockFleetService.getFleet.mockResolvedValue({ id: VALID_FLEET_ID, name: 'Fleet 1' });
      mockFleetService.addPricingGroupToFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups`,
        headers: { authorization: 'Bearer ' + token },
        payload: { pricingGroupId: 'pgr_000000000001' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().pricingGroupId).toBe('pgr_000000000001');
    });

    it('returns 400 for missing pricingGroupId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid pricingGroupId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups`,
        headers: { authorization: 'Bearer ' + token },
        payload: { pricingGroupId: 'not-a-nanoid' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- DELETE /v1/fleets/:id/pricing-groups/:pricingGroupId ---

  describe('DELETE /v1/fleets/:id/pricing-groups/:pricingGroupId', () => {
    it('removes pricing group from fleet', async () => {
      const record = { fleetId: VALID_FLEET_ID, pricingGroupId: 'pgr_000000000001' };
      mockFleetService.removePricingGroupFromFleet.mockResolvedValue(record);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups/pgr_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().pricingGroupId).toBe('pgr_000000000001');
    });

    it('returns 404 when pricing group not found for fleet', async () => {
      mockFleetService.removePricingGroupFromFleet.mockResolvedValue(null);

      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups/pgr_000000000001`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PRICING_ASSIGNMENT_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/fleets/${VALID_FLEET_ID}/pricing-groups/pgr_000000000001`,
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

describe('Fleet feature toggle guard', () => {
  it('returns 403 FLEET_DISABLED when fleet is disabled', async () => {
    const guardApp = Fastify();
    await registerAuth(guardApp);
    await guardApp.register(fleetRoutes);
    guardApp.addHook('onRequest', async (_request, reply) => {
      await reply.status(403).send({ error: 'Fleet is disabled', code: 'FLEET_DISABLED' });
    });
    await guardApp.ready();

    const token = guardApp.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
    const response = await guardApp.inject({
      method: 'GET',
      url: '/fleets',
      headers: { authorization: 'Bearer ' + token },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FLEET_DISABLED');
    await guardApp.close();
  });
});
