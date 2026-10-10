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

// The session (with its station's site) POST /invoices/session/:sessionId reads.
let sessionRows: unknown[] = [];
vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(sessionRows).then(resolve);
  return {
    db: { select: vi.fn(() => chain) },
    client: {},
    invoices: {},
    fleets: {},
    chargingSessions: {},
    chargingStations: {},
    invoiceStatusEnum: { enumValues: ['draft', 'issued', 'paid', 'void', 'credited'] },
    INVOICE_KINDS: ['invoice', 'credit_note'],
    invoiceAuditLog: { __table: 'invoice_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

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
  dispatchDriverNotification: vi
    .fn()
    .mockResolvedValue({ delivered: [{ channel: 'email', recipient: 'driver@example.test' }] }),
}));

vi.mock('@evtivity/services/invoice-audit', () => ({
  wasInvoiceSent: vi.fn().mockResolvedValue(false),
  writeInvoiceSentAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/services/invoice-pdf.service', () => ({
  generateInvoicePdf: vi.fn(),
}));

vi.mock('@evtivity/services/pdf-branding', () => ({
  loadPdfBranding: vi.fn(),
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
  userCanAccessSite: vi.fn((_userId: string, siteId: string | null) =>
    Promise.resolve(userSiteIds === null || (siteId != null && userSiteIds.includes(siteId))),
  ),
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<unknown> } },
      notFound: unknown,
    ) => {
      if (userSiteIds === null) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
}));

import { AppError, dispatchDriverNotification } from '@evtivity/lib';
import { writeAudit } from '@evtivity/database';
import {
  createAggregatedInvoice,
  createSessionInvoice,
  getInvoice,
  markInvoicePaid,
  voidInvoice,
} from '@evtivity/services/invoice.service';
import { creditInvoice } from '@evtivity/services/credit-note.service';
import { sendFleetInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
import { generateInvoicePdf } from '@evtivity/services/invoice-pdf.service';
import { loadPdfBranding } from '@evtivity/services/pdf-branding';
import { wasInvoiceSent, writeInvoiceSentAudit } from '@evtivity/services/invoice-audit';
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
    expect(writeInvoiceSentAudit).toHaveBeenCalledWith(
      {
        invoiceId: CREDIT_NOTE_ID,
        invoiceNumber: 'CN-202607-0001',
        eventType: 'invoice.CreditNote',
        delivered: [{ channel: 'email', recipient: 'driver@example.test' }],
        resend: false,
        actor: {
          actor: 'operator',
          actorUserId: 'usr_000000000001',
          actorDriverId: null,
          actorApiKeyId: null,
          actorLabel: null,
        },
      },
      expect.anything(),
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
    expect(sendFleetInvoiceEmail).toHaveBeenCalledWith(
      CREDIT_NOTE_ID,
      'once',
      { templatesDirs: [] },
      { actor: expect.objectContaining({ actor: 'operator' }), log: expect.anything() },
    );
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
    expect(writeInvoiceSentAudit).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: CREDIT_NOTE_ID, eventType: 'invoice.CreditNote' }),
      expect.anything(),
    );
  });

  function driverInvoiceDetail(): Record<string, unknown> {
    return {
      invoice: invoiceRow({
        issuedAt: new Date('2026-06-30T10:00:00.000Z'),
        dueAt: new Date('2026-07-30T10:00:00.000Z'),
      }),
      lineItems: [],
      driver: null,
      fleet: null,
      taxBreakdown: [],
      creditedInvoice: null,
      creditNote: null,
    };
  }

  it('sends a driver invoice and audits it as invoice_sent by the operator', async () => {
    vi.mocked(getInvoice).mockResolvedValue(driverInvoiceDetail() as never);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'invoice.Sent',
      'drv_000000000001',
      expect.objectContaining({ invoiceNumber: 'INV-202606-0042', totalCents: 1190 }),
      expect.anything(),
      undefined,
    );
    expect(wasInvoiceSent).toHaveBeenCalledWith(INVOICE_ID, expect.anything());
    expect(writeInvoiceSentAudit).toHaveBeenCalledWith(
      {
        invoiceId: INVOICE_ID,
        invoiceNumber: 'INV-202606-0042',
        eventType: 'invoice.Sent',
        delivered: [{ channel: 'email', recipient: 'driver@example.test' }],
        resend: false,
        actor: {
          actor: 'operator',
          actorUserId: 'usr_000000000001',
          actorDriverId: null,
          actorApiKeyId: null,
          actorLabel: null,
        },
      },
      expect.anything(),
    );
  });

  it('marks a send of an invoice sent before as a resend', async () => {
    vi.mocked(getInvoice).mockResolvedValue(driverInvoiceDetail() as never);
    vi.mocked(wasInvoiceSent).mockResolvedValueOnce(true);

    await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(vi.mocked(writeInvoiceSentAudit).mock.calls[0]?.[0]).toMatchObject({ resend: true });
  });

  it('passes an empty delivery list on when no provider accepted the send', async () => {
    vi.mocked(getInvoice).mockResolvedValue(driverInvoiceDetail() as never);
    vi.mocked(dispatchDriverNotification).mockResolvedValueOnce({ delivered: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    // writeInvoiceSentAudit writes nothing for an empty list (invoice-audit tests).
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(writeInvoiceSentAudit).mock.calls[0]?.[0]).toMatchObject({ delivered: [] });
  });

  it('answers 400 INVOICE_NO_DRIVER without sending or auditing', async () => {
    vi.mocked(getInvoice).mockResolvedValue({
      ...driverInvoiceDetail(),
      invoice: invoiceRow({ driverId: null }),
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
    expect(writeInvoiceSentAudit).not.toHaveBeenCalled();
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
    expect(sendFleetInvoiceEmail).toHaveBeenCalledWith(
      INVOICE_ID,
      'resend',
      { templatesDirs: [] },
      {
        actor: expect.objectContaining({ actor: 'operator', actorUserId: 'usr_000000000001' }),
        log: expect.anything(),
      },
    );
    expect(writeInvoiceSentAudit).not.toHaveBeenCalled();
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

describe('GET /invoices/print-logo', () => {
  let app: FastifyInstance;
  let token: string;

  // PNG and JPEG file signatures, enough for the data URI type.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    userSiteIds = null;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    heldPermissions = new Set(['payments:read']);
    userSiteIds = null;
  });

  function getLogo() {
    return app.inject({
      method: 'GET',
      url: '/invoices/print-logo',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('returns the PDF logo as a PNG data URI, behind payments:read', async () => {
    vi.mocked(loadPdfBranding).mockResolvedValue({ logo: PNG, isDefaultLogo: true, footer: '' });

    const res = await getLogo();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logo: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(authorizedPermissions.has('payments:read')).toBe(true);
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it('keeps a JPEG logo a JPEG', async () => {
    vi.mocked(loadPdfBranding).mockResolvedValue({ logo: JPEG, isDefaultLogo: false, footer: '' });

    const res = await getLogo();

    expect(res.json()).toEqual({ logo: `data:image/jpeg;base64,${JPEG.toString('base64')}` });
  });

  it('answers 403 without payments:read', async () => {
    heldPermissions = new Set();

    const res = await getLogo();

    expect(res.statusCode).toBe(403);
    expect(loadPdfBranding).not.toHaveBeenCalled();
  });

  it('answers 404 INVOICE_NOT_FOUND for a site-restricted user', async () => {
    userSiteIds = ['sit_000000000001'];

    const res = await getLogo();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    expect(loadPdfBranding).not.toHaveBeenCalled();
  });
});

describe('invoice routes for a site-restricted user', () => {
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
    expect(writeInvoiceSentAudit).not.toHaveBeenCalled();
  });

  it.each(routes)(
    '$method /invoices/:id$path answers 404 INVOICE_NOT_FOUND for a driver invoice too',
    async (route) => {
      vi.mocked(getInvoice).mockResolvedValue(detail(null) as never);

      const res = await app.inject({
        method: route.method,
        url: `/invoices/${FLEET_INVOICE_ID}${route.path}`,
        headers: { authorization: `Bearer ${token}` },
        ...(route.payload != null ? { payload: route.payload as Record<string, unknown> } : {}),
      });

      // A driver's invoice bills sessions at any site: company-wide money.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
      expect(getInvoice).not.toHaveBeenCalled();
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    },
  );

  it('answers 404 INVOICE_NOT_FOUND on the invoice list and the aggregated invoice', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/invoices',
      headers: { authorization: `Bearer ${token}` },
    });
    const aggregated = await app.inject({
      method: 'POST',
      url: '/invoices/aggregated',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        driverId: 'drv_000000000001',
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-07-01T00:00:00.000Z',
      },
    });

    expect(list.statusCode).toBe(404);
    expect(list.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(aggregated.statusCode).toBe(404);
    expect(createAggregatedInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ['a session at another site', [{ siteId: 'sit_000000000099' }]],
    ['a session at an unsited station', [{ siteId: null }]],
    ['an unknown session', []],
  ])('answers 404 SESSION_NOT_FOUND on the session invoice for %s', async (_label, rows) => {
    sessionRows = rows;

    const res = await app.inject({
      method: 'POST',
      url: '/invoices/session/ses_000000000001',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    expect(createSessionInvoice).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('invoices a session at one of its sites', async () => {
    sessionRows = [{ siteId: 'sit_000000000001' }];
    vi.mocked(createSessionInvoice).mockResolvedValue(detail(null) as never);

    const res = await app.inject({
      method: 'POST',
      url: '/invoices/session/ses_000000000001',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    expect(createSessionInvoice).toHaveBeenCalledWith('ses_000000000001');
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

describe('driver invoice creation audit', () => {
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
    userSiteIds = null;
    sessionRows = [{ siteId: 'sit_000000000001' }];
  });

  function lineItem(id: number, sessionId: string | null): Record<string, unknown> {
    return {
      id,
      invoiceId: INVOICE_ID,
      sessionId,
      paymentRecordId: sessionId == null ? 9 : null,
      description: 'Charging',
      quantity: '1',
      unitPriceCents: 100,
      totalCents: 100,
      taxCents: 19,
      taxRate: '0.19',
      metadata: null,
      createdAt: '2026-06-30T10:00:00.000Z',
    };
  }

  const created = {
    invoice: invoiceRow({ status: 'issued' }),
    lineItems: [
      lineItem(1, 'ses_000000000001'),
      lineItem(2, 'ses_000000000001'),
      lineItem(3, 'ses_000000000002'),
      lineItem(4, null),
    ],
  };

  const aggregatedBody = {
    driverId: 'drv_000000000001',
    startDate: '2026-06-01T00:00:00.000Z',
    endDate: '2026-07-01T00:00:00.000Z',
  };

  it('audits a session invoice as invoice_generated by the operator', async () => {
    vi.mocked(createSessionInvoice).mockResolvedValue(created as never);

    const res = await app.inject({
      method: 'POST',
      url: '/invoices/session/ses_000000000001',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'invoice_id' }),
      expect.objectContaining({
        entityId: INVOICE_ID,
        entityIdSnapshot: INVOICE_ID,
        action: 'invoice_generated',
        actor: 'operator',
        actorUserId: 'usr_000000000001',
        before: null,
        notes: null,
        after: expect.objectContaining({
          totalCents: 1190,
          currency: 'EUR',
          sessionIds: ['ses_000000000001', 'ses_000000000002'],
          sessionCount: 2,
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('audits an aggregated invoice with the billed window', async () => {
    vi.mocked(createAggregatedInvoice).mockResolvedValue(created as never);

    const res = await app.inject({
      method: 'POST',
      url: '/invoices/aggregated',
      headers: { authorization: `Bearer ${token}` },
      payload: aggregatedBody,
    });

    expect(res.statusCode).toBe(201);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'invoice_generated',
        actor: 'operator',
        notes: '2026-06-01T00:00:00.000Z/2026-07-01T00:00:00.000Z',
        after: expect.objectContaining({ sessionCount: 2, currency: 'EUR' }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('audits nothing when the invoice was not created', async () => {
    vi.mocked(createSessionInvoice).mockRejectedValue(new Error('Session already invoiced'));
    vi.mocked(createAggregatedInvoice).mockRejectedValue(
      new AppError('No sessions', 400, 'INVOICE_NO_SESSIONS'),
    );

    const single = await app.inject({
      method: 'POST',
      url: '/invoices/session/ses_000000000001',
      headers: { authorization: `Bearer ${token}` },
    });
    const aggregated = await app.inject({
      method: 'POST',
      url: '/invoices/aggregated',
      headers: { authorization: `Bearer ${token}` },
      payload: aggregatedBody,
    });

    expect(single.statusCode).toBe(400);
    expect(aggregated.statusCode).toBe(400);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
