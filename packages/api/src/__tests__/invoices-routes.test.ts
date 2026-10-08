// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Permission each route asked authorize() for, keyed by the permission.
const authorizedPermissions = new Set<string>();
// Permissions the test user holds; authorize() answers 403 for any other.
let heldPermissions = new Set<string>(['payments:read', 'payments:write']);

vi.mock('../middleware/rbac.js', () => ({
  authorize: (permission: string) => {
    authorizedPermissions.add(permission);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch (err: unknown) {
        await reply.status(401).send({ error: String(err), code: 'UNAUTHORIZED' });
        return;
      }
      if (!heldPermissions.has(permission)) {
        await reply.status(403).send({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    };
  },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  invoices: {},
  fleets: {},
  invoiceStatusEnum: { enumValues: ['draft', 'issued', 'paid', 'void', 'credited'] },
  INVOICE_KINDS: ['invoice', 'credit_note'],
  invoiceAuditLog: { __table: 'invoice_audit_log' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/services/invoice.service', () => ({
  createSessionInvoice: vi.fn(),
  createAggregatedInvoice: vi.fn(),
  getInvoice: vi.fn(),
  voidInvoice: vi.fn(),
  markInvoicePaid: vi.fn(),
}));

vi.mock('@evtivity/services/credit-note.service', () => ({
  creditInvoice: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchDriverNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/services/invoice-pdf.service', () => ({
  generateInvoicePdf: vi.fn(),
}));

vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: [] }));
vi.mock('@evtivity/services/fleet-invoice-notice', () => ({
  sendFleetInvoiceEmail: vi.fn().mockResolvedValue({ status: 'sent', recipients: 1 }),
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: vi.fn() }));

// null: the user has access to every site; an array: a site-restricted user.
let userSiteIds: string[] | null = null;
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(userSiteIds)),
}));

import { AppError, dispatchDriverNotification } from '@evtivity/lib';
import { writeAudit } from '@evtivity/database';
import { getInvoice, markInvoicePaid, voidInvoice } from '@evtivity/services/invoice.service';
import { creditInvoice } from '@evtivity/services/credit-note.service';
import { sendFleetInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
import { generateInvoicePdf } from '@evtivity/services/invoice-pdf.service';
import { registerAuth } from '../plugins/auth.js';
import { invoiceRoutes } from '../routes/invoices.js';

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv_000000000001',
    invoiceNumber: 'INV-202606-0042',
    driverId: 'drv_000000000001',
    fleetId: null,
    periodStart: null,
    periodEnd: null,
    billTo: null,
    language: null,
    sentAt: null,
    overdueNoticeSentAt: null,
    status: 'issued',
    kind: 'invoice',
    creditedInvoiceId: null,
    creditReason: null,
    issuedAt: '2026-06-30T10:00:00.000Z',
    dueAt: '2026-07-30T10:00:00.000Z',
    paidAt: null,
    paymentReference: null,
    currency: 'EUR',
    subtotalCents: 1000,
    taxCents: 190,
    totalCents: 1190,
    metadata: null,
    createdAt: '2026-06-30T10:00:00.000Z',
    updatedAt: '2026-06-30T10:00:00.000Z',
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  // As the API error handler: an AppError answers with its status and code.
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
  invoiceRoutes(app);
  await app.ready();
  return app;
}

const INVOICE_ID = 'inv_000000000001';

describe('PATCH /invoices/:id/paid', () => {
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
    heldPermissions = new Set(['payments:read', 'payments:write']);
  });

  function markPaid(body: Record<string, unknown>, auth = true) {
    return app.inject({
      method: 'PATCH',
      url: `/invoices/${INVOICE_ID}/paid`,
      headers: auth ? { authorization: `Bearer ${token}` } : {},
      payload: body,
    });
  }

  it('requires payments:write', async () => {
    expect(authorizedPermissions.has('payments:write')).toBe(true);
    heldPermissions = new Set(['payments:read']);

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z' });

    expect(res.statusCode).toBe(403);
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });

  it('returns 401 without a token', async () => {
    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z' }, false);
    expect(res.statusCode).toBe(401);
  });

  it('marks the invoice paid with the date and reference and audits it', async () => {
    const before = invoiceRow();
    const after = invoiceRow({
      status: 'paid',
      paidAt: '2026-07-01T09:00:00.000Z',
      paymentReference: 'SEPA 4711',
    });
    vi.mocked(markInvoicePaid).mockResolvedValue({ before, invoice: after } as never);

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z', reference: '  SEPA 4711  ' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid', paymentReference: 'SEPA 4711' });
    expect(markInvoicePaid).toHaveBeenCalledWith(INVOICE_ID, {
      paidAt: new Date('2026-07-01T09:00:00Z'),
      reference: 'SEPA 4711',
    });
    expect(writeAudit).toHaveBeenCalledWith(
      { table: { __table: 'invoice_audit_log' }, idColumn: 'invoice_id' },
      expect.objectContaining({
        entityId: INVOICE_ID,
        action: 'marked_paid',
        actor: 'operator',
        actorUserId: 'usr_000000000001',
        before,
        after,
        notes: 'SEPA 4711',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes a null reference when none is given', async () => {
    vi.mocked(markInvoicePaid).mockResolvedValue({
      before: invoiceRow(),
      invoice: invoiceRow({ status: 'paid' }),
    } as never);

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00+02:00' });

    expect(res.statusCode).toBe(200);
    expect(markInvoicePaid).toHaveBeenCalledWith(INVOICE_ID, {
      paidAt: new Date('2026-07-01T07:00:00Z'),
      reference: null,
    });
  });

  it('refuses a payment date in the future', async () => {
    const res = await markPaid({ paidAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed payment date and a reference over 200 characters', async () => {
    expect((await markPaid({})).statusCode).toBe(400);
    expect((await markPaid({ paidAt: 'yesterday' })).statusCode).toBe(400);
    expect(
      (await markPaid({ paidAt: '2026-07-01T09:00:00Z', reference: 'x'.repeat(201) })).statusCode,
    ).toBe(400);
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });

  it('returns 404 INVOICE_NOT_FOUND for an unknown invoice', async () => {
    vi.mocked(markInvoicePaid).mockResolvedValue(null);

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('returns 409 INVOICE_ALREADY_PAID for a paid invoice without auditing', async () => {
    vi.mocked(markInvoicePaid).mockRejectedValue(
      new AppError('Invoice is already paid', 409, 'INVOICE_ALREADY_PAID'),
    );

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVOICE_ALREADY_PAID' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('returns 409 INVOICE_NOT_ISSUED for a void invoice', async () => {
    vi.mocked(markInvoicePaid).mockRejectedValue(
      new AppError('Only an issued invoice can be marked paid', 409, 'INVOICE_NOT_ISSUED'),
    );

    const res = await markPaid({ paidAt: '2026-07-01T09:00:00Z' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_ISSUED' });
  });
});

describe('PATCH /invoices/:id/void', () => {
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
    heldPermissions = new Set(['payments:read', 'payments:write']);
  });

  function voidRequest() {
    return app.inject({
      method: 'PATCH',
      url: `/invoices/${INVOICE_ID}/void`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('voids the invoice and audits the change', async () => {
    const before = invoiceRow();
    const after = invoiceRow({ status: 'void' });
    vi.mocked(voidInvoice).mockResolvedValue({
      before,
      invoice: after,
      releasedSessionIds: ['ses_000000000001'],
      releasedFeeRecordIds: [9],
    } as never);

    const res = await voidRequest();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'void' });
    expect(res.json()).not.toHaveProperty('releasedSessionIds');
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'invoice_id' }),
      expect.objectContaining({
        action: 'voided',
        before,
        after: { ...after, releasedSessionIds: ['ses_000000000001'], releasedFeeRecordIds: [9] },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not audit an invoice that was already void', async () => {
    const row = invoiceRow({ status: 'void' });
    vi.mocked(voidInvoice).mockResolvedValue({
      before: row,
      invoice: row,
      releasedSessionIds: [],
      releasedFeeRecordIds: [],
    } as never);

    const res = await voidRequest();

    expect(res.statusCode).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown invoice', async () => {
    vi.mocked(voidInvoice).mockResolvedValue(null);

    const res = await voidRequest();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('returns 409 INVOICE_NOT_VOIDABLE for an issued invoice without auditing', async () => {
    vi.mocked(voidInvoice).mockRejectedValue(
      new AppError('Only a draft invoice can be voided', 409, 'INVOICE_NOT_VOIDABLE'),
    );

    const res = await voidRequest();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_VOIDABLE' });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

const CREDIT_NOTE_ID = 'inv_000000000002';

function creditNoteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return invoiceRow({
    id: CREDIT_NOTE_ID,
    invoiceNumber: 'CN-202607-0001',
    kind: 'credit_note',
    creditedInvoiceId: INVOICE_ID,
    creditReason: 'Wrong tariff',
    dueAt: null,
    subtotalCents: -1000,
    taxCents: -190,
    totalCents: -1190,
    ...overrides,
  });
}

function creditNoteDetail(paidAt: string | null = null): Record<string, unknown> {
  return {
    invoice: creditNoteRow({ issuedAt: new Date('2026-07-02T10:00:00.000Z') }),
    lineItems: [],
    driver: null,
    taxBreakdown: [],
    creditedInvoice: {
      id: INVOICE_ID,
      invoiceNumber: 'INV-202606-0042',
      issuedAt: '2026-06-30T10:00:00.000Z',
      paidAt,
    },
    creditNote: null,
  };
}

describe('POST /invoices/:id/credit-note', () => {
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
    authorizedPermissions.clear();
    heldPermissions = new Set(['payments:read', 'payments:write']);
  });

  function creditRequest(body: Record<string, unknown> = { reason: 'Wrong tariff' }) {
    return app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/credit-note`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function credited(): void {
    vi.mocked(creditInvoice).mockResolvedValue({
      before: invoiceRow({ status: 'paid' }),
      original: invoiceRow({ status: 'credited' }),
      creditNote: { invoice: creditNoteRow(), lineItems: [] },
      releasedSessionIds: ['ses_000000000001'],
    } as never);
    vi.mocked(getInvoice).mockResolvedValue(creditNoteDetail('2026-07-01T10:00:00.000Z') as never);
  }

  it('requires payments:write', async () => {
    heldPermissions = new Set(['payments:read']);

    const res = await creditRequest();

    expect(res.statusCode).toBe(403);
    expect(creditInvoice).not.toHaveBeenCalled();
  });

  it('issues the credit note, audits the credit and notifies the driver once', async () => {
    credited();

    const res = await creditRequest({ reason: '  Wrong tariff  ' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      invoice: { id: CREDIT_NOTE_ID, kind: 'credit_note', totalCents: -1190 },
      creditedInvoice: { invoiceNumber: 'INV-202606-0042' },
    });
    expect(creditInvoice).toHaveBeenCalledWith(INVOICE_ID, 'Wrong tariff');
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'invoice_id' }),
      expect.objectContaining({
        entityId: INVOICE_ID,
        action: 'invoice_credited',
        notes: 'Wrong tariff',
        after: expect.objectContaining({
          status: 'credited',
          creditNoteId: CREDIT_NOTE_ID,
          creditNoteNumber: 'CN-202607-0001',
          releasedSessionIds: ['ses_000000000001'],
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(dispatchDriverNotification).toHaveBeenCalledTimes(1);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'invoice.CreditNote',
      'drv_000000000001',
      expect.objectContaining({
        creditNoteNumber: 'CN-202607-0001',
        invoiceNumber: 'INV-202606-0042',
        creditReason: 'Wrong tariff',
        totalCents: 1190,
        currency: 'EUR',
        wasPaid: true,
      }),
      expect.anything(),
      undefined,
    );
  });

  it('emails the credit note of a fleet invoice once to the fleet billing contacts', async () => {
    credited();
    const detail = creditNoteDetail();
    vi.mocked(getInvoice).mockResolvedValue({
      ...detail,
      invoice: { ...(detail['invoice'] as object), driverId: null, fleetId: 'flt_000000000001' },
    } as never);

    const res = await creditRequest();

    expect(res.statusCode).toBe(201);
    expect(sendFleetInvoiceEmail).toHaveBeenCalledWith(CREDIT_NOTE_ID, 'once', {
      templatesDirs: [],
    });
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('still answers 201 when the fleet credit note email fails', async () => {
    credited();
    const detail = creditNoteDetail();
    vi.mocked(getInvoice).mockResolvedValue({
      ...detail,
      invoice: { ...(detail['invoice'] as object), driverId: null, fleetId: 'flt_000000000001' },
    } as never);
    vi.mocked(sendFleetInvoiceEmail).mockRejectedValueOnce(new Error('smtp down'));

    const res = await creditRequest();

    expect(res.statusCode).toBe(201);
  });

  it('refuses an empty reason and one over 500 characters', async () => {
    for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(501) }]) {
      const res = await creditRequest(body);
      expect(res.statusCode).toBe(400);
    }
    expect(creditInvoice).not.toHaveBeenCalled();
  });

  it('returns 404 INVOICE_NOT_FOUND for an unknown invoice', async () => {
    vi.mocked(creditInvoice).mockResolvedValue(null);

    const res = await creditRequest();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each(['INVOICE_ALREADY_CREDITED', 'INVOICE_IS_CREDIT_NOTE', 'INVOICE_NOT_ISSUED'])(
    'returns 409 %s without auditing or notifying',
    async (code) => {
      vi.mocked(creditInvoice).mockRejectedValue(new AppError('Refused', 409, code));

      const res = await creditRequest();

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code });
      expect(writeAudit).not.toHaveBeenCalled();
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    },
  );
});

describe('POST /invoices/:id/send', () => {
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
    heldPermissions = new Set(['payments:read', 'payments:write']);
  });

  it('sends the invoice.CreditNote notification for a credit note', async () => {
    vi.mocked(getInvoice).mockResolvedValue(creditNoteDetail() as never);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${CREDIT_NOTE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'invoice.CreditNote',
      'drv_000000000001',
      expect.objectContaining({ creditNoteNumber: 'CN-202607-0001', wasPaid: false }),
      expect.anything(),
      undefined,
    );
  });

  function fleetInvoiceDetail(): Record<string, unknown> {
    return {
      invoice: invoiceRow({ driverId: null, fleetId: 'flt_000000000001' }),
      lineItems: [],
      driver: null,
      fleet: { id: 'flt_000000000001', name: 'Acme Logistics' },
      taxBreakdown: [],
      creditedInvoice: null,
      creditNote: null,
    };
  }

  it('resends a fleet invoice to the fleet billing contacts', async () => {
    vi.mocked(getInvoice).mockResolvedValue(fleetInvoiceDetail() as never);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(sendFleetInvoiceEmail).toHaveBeenCalledWith(INVOICE_ID, 'resend', {
      templatesDirs: [],
    });
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('returns 400 FLEET_BILLING_CONTACT_REQUIRED when the fleet has no billing contact', async () => {
    vi.mocked(getInvoice).mockResolvedValue(fleetInvoiceDetail() as never);
    vi.mocked(sendFleetInvoiceEmail).mockResolvedValueOnce({ status: 'no_contacts' });

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FLEET_BILLING_CONTACT_REQUIRED' });
  });
});

describe('fleet invoices on the per-invoice routes for a site-restricted user', () => {
  let app: FastifyInstance;
  let token: string;

  const FLEET_INVOICE_ID = 'inv_000000000009';

  function detail(fleetId: string | null): Record<string, unknown> {
    return {
      invoice: invoiceRow({
        id: FLEET_INVOICE_ID,
        driverId: fleetId == null ? 'drv_000000000001' : null,
        fleetId,
      }),
      lineItems: [],
      driver: null,
      fleet: fleetId == null ? null : { id: fleetId, name: 'Acme Logistics' },
      taxBreakdown: [],
      creditedInvoice: null,
      creditNote: null,
    };
  }

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_000000000002', roleId: 'rol_000000000002' });
  });

  afterAll(async () => {
    userSiteIds = null;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    heldPermissions = new Set(['payments:read', 'payments:write']);
    userSiteIds = ['sit_000000000001'];
  });

  const routes: Array<{ method: 'GET' | 'POST' | 'PATCH'; path: string; payload?: unknown }> = [
    { method: 'GET', path: '' },
    { method: 'GET', path: '/pdf' },
    { method: 'GET', path: '/download' },
    { method: 'POST', path: '/send' },
    { method: 'PATCH', path: '/void' },
    { method: 'PATCH', path: '/paid', payload: { paidAt: '2026-07-01T10:00:00.000Z' } },
    { method: 'POST', path: '/credit-note', payload: { reason: 'Wrong period' } },
  ];

  it.each(routes)('$method /invoices/:id$path answers 404 INVOICE_NOT_FOUND', async (route) => {
    vi.mocked(getInvoice).mockResolvedValue(detail('flt_000000000001') as never);

    const res = await app.inject({
      method: route.method,
      url: `/invoices/${FLEET_INVOICE_ID}${route.path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(route.payload != null ? { payload: route.payload as Record<string, unknown> } : {}),
    });

    // The answer for a missing invoice, so the id does not reveal a fleet invoice.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    expect(voidInvoice).not.toHaveBeenCalled();
    expect(markInvoicePaid).not.toHaveBeenCalled();
    expect(creditInvoice).not.toHaveBeenCalled();
    expect(sendFleetInvoiceEmail).not.toHaveBeenCalled();
    expect(generateInvoicePdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('serves a driver invoice to a site-restricted user', async () => {
    vi.mocked(getInvoice).mockResolvedValue(detail(null) as never);

    const res = await app.inject({
      method: 'GET',
      url: `/invoices/${FLEET_INVOICE_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('lets a site-restricted user void a driver invoice', async () => {
    vi.mocked(getInvoice).mockResolvedValue(detail(null) as never);
    vi.mocked(voidInvoice).mockResolvedValue(null);

    const res = await app.inject({
      method: 'PATCH',
      url: `/invoices/${FLEET_INVOICE_ID}/void`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(voidInvoice).toHaveBeenCalledWith(FLEET_INVOICE_ID);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('serves a fleet invoice to a user with access to every site', async () => {
    userSiteIds = null;
    vi.mocked(getInvoice).mockResolvedValue(detail('flt_000000000001') as never);

    const res = await app.inject({
      method: 'GET',
      url: `/invoices/${FLEET_INVOICE_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('reads no invoice for the check when the user has access to every site', async () => {
    userSiteIds = null;
    vi.mocked(voidInvoice).mockResolvedValue(null);

    await app.inject({
      method: 'PATCH',
      url: `/invoices/${FLEET_INVOICE_ID}/void`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getInvoice).not.toHaveBeenCalled();
  });
});
