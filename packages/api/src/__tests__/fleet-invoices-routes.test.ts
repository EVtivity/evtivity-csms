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
    invoices: { fleetId: { name: 'fleet_id' } },
    fleets: { __table: 'fleets', id: { name: 'id' } },
    invoiceStatusEnum: { enumValues: ['draft', 'issued', 'paid', 'void', 'credited'] },
    INVOICE_KINDS: ['invoice', 'credit_note'],
    invoiceAuditLog: { __table: 'invoice_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    getSystemTimezone: vi.fn().mockResolvedValue('UTC'),
  };
});

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, isNull: vi.fn(actual.isNull) };
});

vi.mock('@evtivity/services/fleet-invoice.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/fleet-invoice.service')>()),
  createFleetInvoice: vi.fn(),
  previewFleetInvoice: vi.fn(),
}));
vi.mock('@evtivity/services/fleet-invoice-notice', () => ({
  sendFleetInvoiceEmail: vi.fn(),
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

import { isNull } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { invoices, writeAudit } from '@evtivity/database';
import { createFleetInvoice, previewFleetInvoice } from '@evtivity/services/fleet-invoice.service';
import { sendFleetInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
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
  vi.mocked(sendFleetInvoiceEmail).mockResolvedValue({ status: 'sent', recipients: 2 });
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
    expect(sendFleetInvoiceEmail).toHaveBeenCalledWith(INVOICE_ID, 'once', {
      templatesDirs: ['/t'],
    });
  });

  it('reports emailed false without billing contacts and when the email fails', async () => {
    vi.mocked(sendFleetInvoiceEmail).mockResolvedValueOnce({ status: 'no_contacts' });
    expect((await generate()).json()).toMatchObject({ emailed: false });

    vi.mocked(sendFleetInvoiceEmail).mockRejectedValueOnce(new Error('smtp down'));
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
    expect(sendFleetInvoiceEmail).not.toHaveBeenCalled();
  });

  it('needs payments:write and a YYYY-MM period', async () => {
    expect((await generate({ period: '09/2026' })).statusCode).toBe(400);
    heldPermissions = new Set(['payments:read']);
    expect((await generate()).statusCode).toBe(403);
    expect(createFleetInvoice).not.toHaveBeenCalled();
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
      const listed = await get(`/fleets/${FLEET_ID}/invoices`);
      const filtered = await get(`/invoices?fleetId=${FLEET_ID}`);

      for (const res of [preview, generated, listed, filtered]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: 'FLEET_NOT_FOUND' });
      }
      expect(previewFleetInvoice).not.toHaveBeenCalled();
      expect(createFleetInvoice).not.toHaveBeenCalled();
      expect(sendFleetInvoiceEmail).not.toHaveBeenCalled();
    },
  );
});

describe('GET /invoices without a fleetId filter', () => {
  const list = () =>
    app.inject({ method: 'GET', url: '/invoices', headers: { authorization: `Bearer ${token}` } });

  it.each([
    ['assigned to some sites', ['sit_000000000001']],
    ['assigned to no site', []],
  ])('leaves fleet invoices and credit notes out for a user %s', async (_label, ids) => {
    siteAccess.siteIds = ids;
    listRows.rows = [];
    listRows.total = 0;

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(isNull).toHaveBeenCalledWith(invoices.fleetId);
  });

  it('lists every invoice for a user with access to every site', async () => {
    listRows.rows = [{ ...invoiceRow(), fleetName: 'Acme Logistics' }];
    listRows.total = 1;

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, data: [{ id: INVOICE_ID, fleetId: FLEET_ID }] });
    expect(isNull).not.toHaveBeenCalledWith(invoices.fleetId);
  });
});

describe('GET /fleets/:id/invoices', () => {
  it("lists the fleet's invoices and credit notes", async () => {
    listRows.rows = [{ ...invoiceRow(), fleetName: 'Acme Logistics', sentAt: null }];
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
  });
});
