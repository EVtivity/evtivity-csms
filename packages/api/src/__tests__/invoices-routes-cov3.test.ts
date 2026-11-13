// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Invoice list filters, the invoice detail session labels, the PDF and JSON
// downloads, and the send and credit note edges.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  siteIds: null as string[] | null,
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
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(state.siteIds)),
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<unknown> } },
      notFound: unknown,
    ) => {
      if (state.siteIds === null) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...c: unknown[]) => ({ and: c })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));

vi.mock('@evtivity/database', () => {
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop === 'string' && prop !== 'then' ? `${name}.${prop}` : undefined,
      },
    );
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin']) {
      c[m] = vi.fn(() => c);
    }
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? []).then(resolve, reject);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    client: {},
    invoices: table('invoices'),
    fleets: table('fleets'),
    chargingSessions: table('chargingSessions'),
    chargingStations: table('chargingStations'),
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
vi.mock('@evtivity/services/credit-note.service', () => ({ creditInvoice: vi.fn() }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchDriverNotification: vi.fn().mockResolvedValue({ delivered: [] }),
}));
vi.mock('@evtivity/services/invoice-audit', () => ({
  wasInvoiceSent: vi.fn().mockResolvedValue(false),
  writeInvoiceSentAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@evtivity/services/invoice-pdf.service', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@evtivity/services/pdf-branding', () => ({ loadPdfBranding: vi.fn() }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: [] }));
vi.mock('@evtivity/services/fleet-invoice-notice', () => ({
  sendAccountInvoiceEmail: vi.fn().mockResolvedValue({ status: 'sent', recipients: 1 }),
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: vi.fn() }));

import { eq, inArray } from 'drizzle-orm';
import { dispatchDriverNotification } from '@evtivity/lib';
import { getInvoice } from '@evtivity/services/invoice.service';
import { creditInvoice } from '@evtivity/services/credit-note.service';
import { generateInvoicePdf } from '@evtivity/services/invoice-pdf.service';
import { registerAuth } from '../plugins/auth.js';
import { invoiceRoutes } from '../routes/invoices.js';

const INVOICE_ID = 'inv_000000000001';
const CREDIT_NOTE_ID = 'inv_000000000002';

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    invoiceNumber: 'INV-202606-0042',
    driverId: 'drv_000000000001',
    fleetId: null,
    memberBilled: false,
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

function lineItem(id: number, sessionId: string | null): Record<string, unknown> {
  return {
    id,
    invoiceId: INVOICE_ID,
    sessionId,
    paymentRecordId: null,
    description: `Charging ${String(id)}`,
    quantity: '1',
    unitPriceCents: 500,
    totalCents: 500,
    taxCents: 95,
    taxRate: '0.19',
    metadata: null,
    createdAt: '2026-06-30T10:00:00.000Z',
  };
}

function detail(over: Record<string, unknown> = {}, items: unknown[] = []) {
  return {
    invoice: invoiceRow(over),
    lineItems: items,
    driver: null,
    taxBreakdown: [],
    creditedInvoice: null,
    creditNote: null,
  };
}

describe('invoice routes - cov3', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    invoiceRoutes(app);
    await app.ready();
    headers = {
      authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_1' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.results = [];
    state.siteIds = null;
  });

  it('filters the list by fleet, status and kind', async () => {
    state.results.push(
      [{ ...invoiceRow({ fleetId: 'flt_000000000001' }), fleetName: 'Acme', driverName: null }],
      [{ count: 1 }],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/invoices?fleetId=flt_000000000001&status=paid&kind=credit_note',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, data: [{ id: INVOICE_ID }] });
    expect(eq).toHaveBeenCalledWith('invoices.fleetId', 'flt_000000000001');
    expect(eq).toHaveBeenCalledWith('invoices.status', 'paid');
    expect(eq).toHaveBeenCalledWith('invoices.kind', 'credit_note');
  });

  it('names each line item session by its station and start, one read for all', async () => {
    vi.mocked(getInvoice).mockResolvedValueOnce(
      detail({}, [
        lineItem(1, 'ses_000000000001'),
        lineItem(2, 'ses_000000000001'),
        lineItem(3, null),
        lineItem(4, 'ses_000000000009'),
      ]) as never,
    );
    state.results.push([
      { id: 'ses_000000000001', stationOcppId: 'CS-1', startedAt: '2026-06-01T08:00:00.000Z' },
    ]);
    const res = await app.inject({ method: 'GET', url: `/invoices/${INVOICE_ID}`, headers });
    expect(res.statusCode).toBe(200);
    const items = res.json().lineItems as Array<Record<string, unknown>>;
    expect(items.map((i) => i['sessionStationOcppId'])).toEqual(['CS-1', 'CS-1', null, null]);
    expect(items[0]?.['sessionStartedAt']).toBe('2026-06-01T08:00:00.000Z');
    expect(items[3]?.['sessionStartedAt']).toBeNull();
    expect(inArray).toHaveBeenCalledTimes(1);
    expect(inArray).toHaveBeenCalledWith('chargingSessions.id', [
      'ses_000000000001',
      'ses_000000000009',
    ]);
  });

  it('reads no sessions for line items without one', async () => {
    vi.mocked(getInvoice).mockResolvedValueOnce(detail({}, [lineItem(1, null)]) as never);
    const res = await app.inject({ method: 'GET', url: `/invoices/${INVOICE_ID}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().lineItems[0]).toMatchObject({
      sessionStationOcppId: null,
      sessionStartedAt: null,
    });
    expect(inArray).not.toHaveBeenCalled();
  });

  it.each(['', '/pdf', '/download'])('answers 404 for an unknown invoice on %s', async (suffix) => {
    vi.mocked(getInvoice).mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'GET',
      url: `/invoices/${INVOICE_ID}${suffix}`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('INVOICE_NOT_FOUND');
    expect(generateInvoicePdf).not.toHaveBeenCalled();
  });

  it('streams the PDF as an attachment named by the invoice number', async () => {
    const result = detail();
    vi.mocked(getInvoice).mockResolvedValueOnce(result as never);
    vi.mocked(generateInvoicePdf).mockResolvedValueOnce(Buffer.from('%PDF-1.7'));
    const res = await app.inject({ method: 'GET', url: `/invoices/${INVOICE_ID}/pdf`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-202606-0042.pdf"');
    expect(res.body).toBe('%PDF-1.7');
    expect(generateInvoicePdf).toHaveBeenCalledWith(result);
  });

  it('downloads the invoice as a JSON attachment', async () => {
    vi.mocked(getInvoice).mockResolvedValueOnce(detail() as never);
    const res = await app.inject({
      method: 'GET',
      url: `/invoices/${INVOICE_ID}/download`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-202606-0042.json"');
    expect(res.json()).toMatchObject({ invoice: { invoiceNumber: 'INV-202606-0042' } });
  });

  it('answers 404 for the downloads of a site-restricted user before reading', async () => {
    state.siteIds = ['sit_000000000001'];
    for (const suffix of ['/pdf', '/download']) {
      const res = await app.inject({
        method: 'GET',
        url: `/invoices/${INVOICE_ID}${suffix}`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    }
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it('answers 404 when sending an unknown invoice', async () => {
    vi.mocked(getInvoice).mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/send`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('INVOICE_NOT_FOUND');
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('notifies nobody for the credit note of an invoice without a driver', async () => {
    vi.mocked(creditInvoice).mockResolvedValueOnce({
      before: invoiceRow({ driverId: null }),
      original: invoiceRow({ driverId: null, status: 'credited' }),
      creditNote: {
        invoice: invoiceRow({ id: CREDIT_NOTE_ID, kind: 'credit_note', driverId: null }),
        lineItems: [],
      },
      releasedSessionIds: [],
    } as never);
    vi.mocked(getInvoice).mockResolvedValueOnce(
      detail({
        id: CREDIT_NOTE_ID,
        invoiceNumber: 'CN-202607-0001',
        kind: 'credit_note',
        driverId: null,
        totalCents: -1190,
      }) as never,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${INVOICE_ID}/credit-note`,
      headers,
      payload: { reason: 'Wrong tariff' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ invoice: { id: CREDIT_NOTE_ID, driverId: null } });
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });
});
