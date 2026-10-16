// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let heldPermissions = new Set<string>(['payments:read', 'payments:write']);

vi.mock('../middleware/rbac.js', () => ({
  authorize: (permission: string) => {
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      await request.jwtVerify();
      if (!heldPermissions.has(permission)) {
        await reply.status(403).send({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    };
  },
  invalidatePermissionCache: vi.fn(),
}));

const listRows = vi.hoisted(() => ({ rows: [] as unknown[], total: 0 }));
// Tables the list queries join: the fleet name column needs the fleets join.
const joined = vi.hoisted(() => ({ tables: [] as unknown[] }));
// The user's sites: null is access to every site; a list restricts the user.
const siteAccess = vi.hoisted(() => ({ siteIds: null as string[] | null }));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(siteAccess.siteIds)),
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<unknown> } },
      notFound: unknown,
    ) => {
      if (siteAccess.siteIds === null) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
}));

vi.mock('@evtivity/database', () => {
  const chain = (result: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) c[m] = vi.fn(() => c);
    c['leftJoin'] = vi.fn((table: unknown) => {
      joined.tables.push(table);
      return c;
    });
    c['offset'] = vi.fn(() => Promise.resolve(result()));
    c['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ count: listRows.total }]).then(resolve);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain(() => listRows.rows)) },
    client: {},
    invoices: { fleetId: { name: 'fleet_id' }, memberBilled: { name: 'member_billed' } },
    fleets: { __table: 'fleets', id: { name: 'id' } },
    drivers: { __table: 'drivers', id: { name: 'id' } },
    invoiceStatusEnum: { enumValues: ['draft', 'issued', 'paid', 'void', 'credited'] },
    INVOICE_KINDS: ['invoice', 'credit_note'],
    invoiceAuditLog: { __table: 'invoice_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    getSystemTimezone: vi.fn().mockResolvedValue('UTC'),
    listMovableFleetSessions: vi.fn(),
  };
});

vi.mock('../services/session-billing-recipient.service.js', () => ({
  moveSessionsBilling: vi.fn(),
}));

vi.mock('@evtivity/services/fleet-invoice.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/fleet-invoice.service')>()),
  createFleetInvoice: vi.fn(),
  createMemberInvoice: vi.fn(),
  listMemberInvoiceDrivers: vi.fn(),
  previewFleetInvoice: vi.fn(),
}));
vi.mock('@evtivity/services/fleet-invoice-run', () => ({
  enqueueMemberInvoiceBatch: vi.fn(),
}));
const memberQueue = { addBulk: vi.fn() };
vi.mock('@evtivity/lib/job-queues', () => ({ jobQueue: () => memberQueue }));
vi.mock('@evtivity/services/fleet-invoice-notice', () => ({
  sendAccountInvoiceEmail: vi.fn(),
}));
vi.mock('@evtivity/services/invoice.service', () => ({
  createSessionInvoice: vi.fn(),
  createAggregatedInvoice: vi.fn(),
  getInvoice: vi.fn(),
  voidInvoice: vi.fn(),
  markInvoicePaid: vi.fn(),
}));
vi.mock('@evtivity/services/credit-note.service', () => ({ creditInvoice: vi.fn() }));
vi.mock('@evtivity/services/invoice-pdf.service', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/t'] }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: vi.fn() }));

import { AppError } from '@evtivity/lib';
import { db, listMovableFleetSessions, writeAudit } from '@evtivity/database';
import { moveSessionsBilling } from '../services/session-billing-recipient.service.js';
import {
  createFleetInvoice,
  createMemberInvoice,
  listMemberInvoiceDrivers,
  previewFleetInvoice,
} from '@evtivity/services/fleet-invoice.service';
import { enqueueMemberInvoiceBatch } from '@evtivity/services/fleet-invoice-run';
import { sendAccountInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
import { getInvoice } from '@evtivity/services/invoice.service';
import { registerAuth } from '../plugins/auth.js';
import { fleetInvoiceRoutes } from '../routes/fleet-invoices.js';
import { invoiceRoutes } from '../routes/invoices.js';

const FLEET_ID = 'flt_000000000001';
const INVOICE_ID = 'inv_000000000009';

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    invoiceNumber: 'INV-202610-0009',
    driverId: null,
    fleetId: FLEET_ID,
    memberBilled: false,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    billTo: { name: 'Acme Logistics GmbH' },
    language: 'de',
    sentAt: null,
    overdueNoticeSentAt: null,
    status: 'issued',
    kind: 'invoice',
    creditedInvoiceId: null,
    creditReason: null,
    issuedAt: '2026-10-02T10:00:00.000Z',
    dueAt: '2026-10-16T10:00:00.000Z',
    paidAt: null,
    paymentReference: null,
    currency: 'EUR',
    subtotalCents: 2000,
    taxCents: 380,
    totalCents: 2380,
    metadata: null,
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

const driverTotal = {
  driverId: 'drv_000000000001',
  driverName: 'Anna Berg',
  sessionCount: 2,
  energyWh: 24000,
  netCents: 2000,
  taxCents: 380,
  totalCents: 2380,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  app.setErrorHandler(async (error, _request, reply) => {
    if ((error as { validation?: unknown }).validation != null) {
      await reply.status(400).send({ error: String(error), code: 'VALIDATION_ERROR' });
      return;
    }
    if (error instanceof AppError) {
      await reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    await reply.status(500).send({ error: String(error), code: 'INTERNAL_ERROR' });
  });
  fleetInvoiceRoutes(app);
  invoiceRoutes(app);
  await app.ready();
  return app;
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildApp();
  token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  siteAccess.siteIds = null;
  heldPermissions = new Set(['payments:read', 'payments:write']);
  vi.mocked(createFleetInvoice).mockResolvedValue({
    invoice: invoiceRow(),
    lineItems: [{ sessionId: 'ses_000000000001' }, { sessionId: 'ses_000000000001' }],
    drivers: [driverTotal],
    excluded: [],
    excludedCount: 3,
  } as never);
  vi.mocked(getInvoice).mockResolvedValue({
    invoice: invoiceRow(),
    lineItems: [],
    driver: null,
    fleet: { id: FLEET_ID, name: 'Acme Logistics' },
    taxBreakdown: [],
    creditedInvoice: null,
    creditNote: null,
  } as never);
  vi.mocked(sendAccountInvoiceEmail).mockResolvedValue({ status: 'sent', recipients: 2 });
});

function generate(body: Record<string, unknown> = { period: '2026-09' }) {
  return app.inject({
    method: 'POST',
    url: `/fleets/${FLEET_ID}/invoices`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('GET /fleets/:id/billing/unbilled', () => {
  const preview = {
    fleetId: FLEET_ID,
    period: '2026-09',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    currency: 'EUR',
    sessionCount: 2,
    energyWh: 24000,
    netCents: 2000,
    taxCents: 380,
    totalCents: 2380,
    drivers: [driverTotal],
    excluded: [
      {
        sessionId: 'ses_000000000002',
        driverId: 'drv_000000000001',
        driverName: 'Anna Berg',
        endedAt: new Date('2026-09-03T10:00:00Z'),
        reason: 'other_currency' as const,
        currency: 'USD',
        finalCostCents: 500,
      },
    ],
    excludedCount: 1,
    existingInvoice: null,
    members: [
      {
        driverId: 'drv_000000000002',
        driverName: 'Zoe Ng',
        sessionCount: 1,
        energyWh: 12000,
        netCents: 1000,
        taxCents: 190,
        totalCents: 1190,
        existingInvoice: null,
        hasEmail: true,
        hasAddress: false,
      },
    ],
  };

  it('previews the given period', async () => {
    vi.mocked(previewFleetInvoice).mockResolvedValue(preview);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/billing/unbilled?period=2026-09`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(previewFleetInvoice).toHaveBeenCalledWith(FLEET_ID, '2026-09');
    expect(res.json()).toMatchObject({
      totalCents: 2380,
      excluded: [{ reason: 'other_currency' }],
      members: [{ driverId: 'drv_000000000002', hasEmail: true, hasAddress: false }],
    });
  });

  it('defaults to the previous month and needs payments:read', async () => {
    vi.mocked(previewFleetInvoice).mockResolvedValue(preview);
    await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/billing/unbilled`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(vi.mocked(previewFleetInvoice).mock.calls[0]?.[1]).toMatch(/^\d{4}-\d{2}$/);

    heldPermissions = new Set();
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/billing/unbilled`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a malformed period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/billing/unbilled?period=2026-9`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(previewFleetInvoice).not.toHaveBeenCalled();
  });
});

describe('POST /fleets/:id/invoices', () => {
  it('issues the invoice, audits it and emails it once', async () => {
    const res = await generate();

    expect(res.statusCode).toBe(201);
    expect(createFleetInvoice).toHaveBeenCalledWith(FLEET_ID, '2026-09');
    expect(res.json()).toMatchObject({
      invoice: { id: INVOICE_ID, fleetId: FLEET_ID, periodStart: '2026-09-01' },
      fleet: { name: 'Acme Logistics' },
      drivers: [{ driverName: 'Anna Berg' }],
      excludedCount: 3,
      emailed: true,
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'invoice_id' }),
      expect.objectContaining({
        entityId: INVOICE_ID,
        action: 'invoice_generated',
        notes: '2026-09',
        after: expect.objectContaining({ sessionIds: ['ses_000000000001'], excludedCount: 3 }),
      }),
      expect.anything(),
      expect.anything(),
    );
    // The issue email is audited as invoice_sent by the operator who generated it.
    expect(sendAccountInvoiceEmail).toHaveBeenCalledWith(
      INVOICE_ID,
      'once',
      { templatesDirs: ['/t'] },
      {
        actor: expect.objectContaining({ actor: 'operator' }),
        log: expect.anything(),
      },
    );
  });

  it('reports emailed false without billing contacts and when the email fails', async () => {
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValueOnce({ status: 'no_contacts' });
    expect((await generate()).json()).toMatchObject({ emailed: false });

    vi.mocked(sendAccountInvoiceEmail).mockRejectedValueOnce(new Error('smtp down'));
    const res = await generate();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: false });
  });

  it.each([
    [409, 'FLEET_INVOICE_PERIOD_EXISTS'],
    [409, 'FLEET_INVOICE_NOTHING_TO_BILL'],
    [404, 'FLEET_NOT_FOUND'],
    [400, 'INVOICE_CREATION_FAILED'],
  ])('answers %i %s without auditing or emailing', async (status, code) => {
    vi.mocked(createFleetInvoice).mockRejectedValueOnce(new AppError('Refused', status, code));

    const res = await generate();

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
    expect(writeAudit).not.toHaveBeenCalled();
    expect(sendAccountInvoiceEmail).not.toHaveBeenCalled();
  });

  it('needs payments:write and a YYYY-MM period', async () => {
    expect((await generate({ period: '09/2026' })).statusCode).toBe(400);
    heldPermissions = new Set(['payments:read']);
    expect((await generate()).statusCode).toBe(403);
    expect(createFleetInvoice).not.toHaveBeenCalled();
  });
});

const DRIVER_ID = 'drv_000000000001';

function generateMember(
  body: Record<string, unknown> = { period: '2026-09', driverId: DRIVER_ID },
) {
  return app.inject({
    method: 'POST',
    url: `/fleets/${FLEET_ID}/member-invoices`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

function batchMembers(body: Record<string, unknown> = { period: '2026-09' }) {
  return app.inject({
    method: 'POST',
    url: `/fleets/${FLEET_ID}/member-invoices/batch`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('POST /fleets/:id/member-invoices', () => {
  beforeEach(() => {
    vi.mocked(createMemberInvoice).mockResolvedValue({
      invoice: invoiceRow({ driverId: DRIVER_ID, memberBilled: true }),
      lineItems: [{ sessionId: 'ses_000000000002' }],
      drivers: [driverTotal],
      excluded: [],
      excludedCount: 0,
    } as never);
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValue({ status: 'sent', recipients: 1 });
  });

  it("issues one driver's member invoice, audits it and sends it to the driver once", async () => {
    const res = await generateMember();

    expect(res.statusCode).toBe(201);
    expect(createMemberInvoice).toHaveBeenCalledWith(FLEET_ID, DRIVER_ID, '2026-09');
    expect(res.json()).toMatchObject({ emailed: true, drivers: [{ driverName: 'Anna Berg' }] });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: INVOICE_ID,
        action: 'invoice_generated',
        notes: '2026-09',
        after: expect.objectContaining({ sessionIds: ['ses_000000000002'] }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(sendAccountInvoiceEmail).toHaveBeenCalledWith(
      INVOICE_ID,
      'once',
      { templatesDirs: ['/t'] },
      expect.objectContaining({ actor: expect.objectContaining({ actor: 'operator' }) }),
    );
  });

  it('reports emailed false for a driver without an email and when the send fails', async () => {
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValueOnce({ status: 'no_email' });
    expect((await generateMember()).json()).toMatchObject({ emailed: false });
    vi.mocked(sendAccountInvoiceEmail).mockRejectedValueOnce(new Error('smtp down'));
    const res = await generateMember();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: false });
  });

  it.each([
    [409, 'FLEET_INVOICE_PERIOD_EXISTS'],
    [409, 'FLEET_INVOICE_NOTHING_TO_BILL'],
    [404, 'FLEET_NOT_FOUND'],
    [404, 'DRIVER_NOT_FOUND'],
  ])('answers %i %s without auditing or sending', async (status, code) => {
    vi.mocked(createMemberInvoice).mockRejectedValueOnce(new AppError('Refused', status, code));
    const res = await generateMember();
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
    expect(writeAudit).not.toHaveBeenCalled();
    expect(sendAccountInvoiceEmail).not.toHaveBeenCalled();
  });

  it('needs payments:write, a period and a driver id', async () => {
    expect((await generateMember({ period: '2026-09' })).statusCode).toBe(400);
    expect((await generateMember({ period: '2026-9', driverId: DRIVER_ID })).statusCode).toBe(400);
    heldPermissions = new Set(['payments:read']);
    expect((await generateMember()).statusCode).toBe(403);
    expect(createMemberInvoice).not.toHaveBeenCalled();
  });
});

describe('POST /fleets/:id/member-invoices/batch', () => {
  it('queues one job per driver for the worker and answers 202 with the driver count', async () => {
    vi.mocked(listMemberInvoiceDrivers).mockResolvedValue(['drv_000000000001', 'drv_000000000002']);

    const res = await batchMembers();

    expect(res.statusCode).toBe(202);
    const body = res.json<{ batchId: string; memberCount: number }>();
    expect(body.memberCount).toBe(2);
    expect(body.batchId).toMatch(/^[a-f0-9-]{36}$/);
    expect(listMemberInvoiceDrivers).toHaveBeenCalledWith(FLEET_ID, '2026-09');
    // Nothing is written in the request (P4): the worker issues the invoices.
    expect(enqueueMemberInvoiceBatch).toHaveBeenCalledWith(memberQueue, {
      fleetId: FLEET_ID,
      period: '2026-09',
      batchId: body.batchId,
      actor: { actor: 'operator', actorUserId: 'usr_000000000001', actorApiKeyId: null },
      driverIds: ['drv_000000000001', 'drv_000000000002'],
    });
    expect(createMemberInvoice).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('answers 500 when the jobs cannot be queued, so the operator can try again', async () => {
    vi.mocked(listMemberInvoiceDrivers).mockResolvedValue(['drv_000000000001']);
    vi.mocked(enqueueMemberInvoiceBatch).mockRejectedValueOnce(new Error('redis down'));
    const res = await batchMembers();
    expect(res.statusCode).toBe(500);
    expect(createMemberInvoice).not.toHaveBeenCalled();
  });

  it('answers 409 FLEET_INVOICE_NOTHING_TO_BILL and queues nothing when no driver qualifies', async () => {
    vi.mocked(listMemberInvoiceDrivers).mockResolvedValue([]);
    const res = await batchMembers();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'FLEET_INVOICE_NOTHING_TO_BILL' });
    expect(enqueueMemberInvoiceBatch).not.toHaveBeenCalled();
  });

  it('passes the service refusals through and needs payments:write', async () => {
    vi.mocked(listMemberInvoiceDrivers).mockRejectedValueOnce(
      new AppError('Fleet not found', 404, 'FLEET_NOT_FOUND'),
    );
    expect((await batchMembers()).statusCode).toBe(404);
    expect((await batchMembers({ period: 'x' })).statusCode).toBe(400);
    heldPermissions = new Set(['payments:read']);
    expect((await batchMembers()).statusCode).toBe(403);
    expect(enqueueMemberInvoiceBatch).not.toHaveBeenCalled();
  });
});

describe('site-restricted users (a fleet invoice spans sites)', () => {
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it.each([
    ['assigned to some sites', ['sit_000000000001']],
    ['assigned to no site', []],
  ])(
    'answers 404 FLEET_NOT_FOUND on preview, generate and list for a user %s',
    async (_label, ids) => {
      siteAccess.siteIds = ids;

      const preview = await get(`/fleets/${FLEET_ID}/billing/unbilled?period=2026-09`);
      const generated = await generate();
      const member = await generateMember();
      const batch = await batchMembers();
      const listed = await get(`/fleets/${FLEET_ID}/invoices`);
      const filtered = await get(`/invoices?fleetId=${FLEET_ID}`);

      for (const res of [preview, generated, member, batch, listed]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: 'FLEET_NOT_FOUND' });
      }
      // The invoice list spans sites whatever the filter.
      expect(filtered.statusCode).toBe(404);
      expect(filtered.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
      expect(previewFleetInvoice).not.toHaveBeenCalled();
      expect(createFleetInvoice).not.toHaveBeenCalled();
      expect(createMemberInvoice).not.toHaveBeenCalled();
      expect(enqueueMemberInvoiceBatch).not.toHaveBeenCalled();
      expect(sendAccountInvoiceEmail).not.toHaveBeenCalled();
    },
  );
});

describe('GET /invoices without a fleetId filter', () => {
  const list = () =>
    app.inject({ method: 'GET', url: '/invoices', headers: { authorization: `Bearer ${token}` } });

  it.each([
    ['assigned to some sites', ['sit_000000000001']],
    ['assigned to no site', []],
  ])('answers 404 INVOICE_NOT_FOUND for a user %s: invoices span sites', async (_label, ids) => {
    siteAccess.siteIds = ids;
    listRows.rows = [{ ...invoiceRow(), fleetName: 'Acme Logistics' }];
    listRows.total = 1;

    const res = await list();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('lists every invoice for a user with access to every site', async () => {
    listRows.rows = [{ ...invoiceRow(), fleetName: 'Acme Logistics' }];
    listRows.total = 1;

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, data: [{ id: INVOICE_ID, fleetId: FLEET_ID }] });
  });
});

describe('GET /fleets/:id/invoices', () => {
  it("lists the fleet's invoices and credit notes", async () => {
    listRows.rows = [
      { ...invoiceRow(), fleetName: 'Acme Logistics', driverName: null, sentAt: null },
    ];
    listRows.total = 1;
    joined.tables = [];
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/invoices`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 1,
      data: [{ id: INVOICE_ID, fleetName: 'Acme Logistics', periodStart: '2026-09-01' }],
    });
    // The list selects fleets.name, so the query must join fleets.
    expect(joined.tables).toContainEqual({ __table: 'fleets', id: { name: 'id' } });
    // ...and the member invoice's driver name, so it joins drivers.
    expect(joined.tables).toContainEqual({ __table: 'drivers', id: { name: 'id' } });
  });

  it('lists member invoices with the driver name and filters by recipient', async () => {
    listRows.rows = [
      {
        ...invoiceRow({ driverId: DRIVER_ID, memberBilled: true }),
        fleetName: 'Acme Logistics',
        driverName: 'Anna Berg',
      },
    ];
    listRows.total = 1;
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/invoices?recipient=member`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: [{ memberBilled: true, driverId: DRIVER_ID, driverName: 'Anna Berg' }],
    });
    const bad = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/invoices?recipient=driver`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /fleets/:id/billing-recipient', () => {
  const DRIVER_A = 'drv_00000000000a';

  /** The fleet row the route reads before the move. */
  function fleetRow(row: Record<string, unknown> | null): void {
    vi.mocked(db.select).mockImplementationOnce(
      () =>
        ({
          from: () => ({ where: () => Promise.resolve(row == null ? [] : [row]) }),
        }) as never,
    );
  }

  function move(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/billing-recipient`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  const body = { recipient: 'member', driverIds: [DRIVER_A], period: '2026-09' };

  beforeEach(() => {
    vi.mocked(listMovableFleetSessions).mockReset();
    vi.mocked(moveSessionsBilling).mockReset();
  });

  it("moves the preview's sessions of the drivers and reports each outcome", async () => {
    fleetRow({ accountBillingEnabled: true });
    vi.mocked(listMovableFleetSessions).mockResolvedValueOnce(['ses_1', 'ses_2']);
    vi.mocked(moveSessionsBilling).mockResolvedValueOnce([
      {
        sessionId: 'ses_1',
        outcome: 'moved',
        driverId: DRIVER_A,
        fleetId: FLEET_ID,
        from: 'fleet',
      },
      {
        sessionId: 'ses_2',
        outcome: 'invoiced',
        driverId: DRIVER_A,
        fleetId: FLEET_ID,
        from: 'fleet',
      },
    ]);
    const res = await move(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      movedCount: 1,
      sessions: [
        { sessionId: 'ses_1', driverId: DRIVER_A, outcome: 'moved' },
        { sessionId: 'ses_2', driverId: DRIVER_A, outcome: 'invoiced' },
      ],
    });
    expect(listMovableFleetSessions).toHaveBeenCalledWith(expect.anything(), {
      fleetId: FLEET_ID,
      driverIds: [DRIVER_A],
      recipient: 'member',
      endsBefore: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(moveSessionsBilling).toHaveBeenCalledWith(
      ['ses_1', 'ses_2'],
      'member',
      expect.objectContaining({ actor: expect.objectContaining({ actor: 'operator' }) }),
    );
  });

  it('refuses a fleet without account billing and an unknown fleet', async () => {
    fleetRow({ accountBillingEnabled: false });
    const off = await move(body);
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('FLEET_ACCOUNT_BILLING_OFF');
    fleetRow(null);
    expect((await move(body)).json().code).toBe('FLEET_NOT_FOUND');
    expect(moveSessionsBilling).not.toHaveBeenCalled();
  });

  it('refuses a site-restricted user, no drivers and a missing permission', async () => {
    siteAccess.siteIds = ['sit_000000000001'];
    try {
      expect((await move(body)).statusCode).toBe(404);
    } finally {
      siteAccess.siteIds = null;
    }
    expect((await move({ ...body, driverIds: [] })).statusCode).toBe(400);
    heldPermissions = new Set(['payments:read']);
    try {
      expect((await move(body)).statusCode).toBe(403);
    } finally {
      heldPermissions = new Set(['payments:read', 'payments:write']);
    }
    expect(moveSessionsBilling).not.toHaveBeenCalled();
  });
});
