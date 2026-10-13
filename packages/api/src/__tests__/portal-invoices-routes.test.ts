// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

const { invoicesTable, getInvoice, generateInvoicePdf } = vi.hoisted(() => ({
  invoicesTable: {
    id: 'invoices.id',
    driverId: 'invoices.driver_id',
    fleetId: 'invoices.fleet_id',
    memberBilled: 'invoices.member_billed',
    status: 'invoices.status',
    createdAt: 'invoices.created_at',
  },
  getInvoice: vi.fn(),
  generateInvoicePdf: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  invoices: invoicesTable,
  fleets: { id: 'fleets.id', name: 'fleets.name' },
  invoiceStatusEnum: { enumValues: ['draft', 'issued', 'paid', 'void', 'credited'] },
  INVOICE_KINDS: ['invoice', 'credit_note'],
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  notInArray: vi.fn((col: unknown, vals: unknown) => ({ op: 'notInArray', col, vals })),
  desc: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@evtivity/services/invoice.service', () => ({
  getInvoice: (...args: unknown[]) => getInvoice(...args) as unknown,
}));

vi.mock('@evtivity/services/invoice-pdf.service', () => ({
  generateInvoicePdf: (...args: unknown[]) => generateInvoicePdf(...args) as unknown,
}));

import { eq, notInArray } from 'drizzle-orm';
import { registerAuth } from '../plugins/auth.js';
import { portalInvoiceRoutes, toPortalInvoiceDetail } from '../routes/portal/invoices.js';
import type { InvoiceDetail } from '@evtivity/services/invoice.service';

const DRIVER_ID = 'drv_000000000001';
const INVOICE_ID = 'inv_000000000001';

function memberDetail(): InvoiceDetail {
  const now = new Date('2026-11-01T00:15:00Z');
  return {
    invoice: {
      id: INVOICE_ID,
      invoiceNumber: 'INV-202611-0003',
      driverId: DRIVER_ID,
      fleetId: 'flt_000000000001',
      memberBilled: true,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      billTo: { name: 'Erika Muster', city: 'Berlin', email: 'erika@example.com' },
      language: 'de',
      status: 'issued',
      kind: 'invoice',
      creditedInvoiceId: null,
      creditReason: null,
      issuedAt: now,
      dueAt: now,
      paidAt: null,
      paymentReference: 'internal-ref',
      currency: 'EUR',
      subtotalCents: 1000,
      taxCents: 190,
      totalCents: 1190,
      metadata: { operatorNote: 'internal' },
      createdAt: now,
      updatedAt: now,
    },
    lineItems: [
      {
        id: 1,
        invoiceId: INVOICE_ID,
        sessionId: 'ses_000000000001',
        paymentRecordId: null,
        description: 'Charging session',
        quantity: '1',
        unitPriceCents: 1000,
        totalCents: 1000,
        taxCents: 190,
        taxRate: '0.19',
        metadata: {
          kind: 'session',
          sessionDate: '2026-10-05',
          energyWh: 12000,
          stationName: 'Hof 1',
          driverId: DRIVER_ID,
          driverName: 'Erika Muster',
        },
        createdAt: now,
      },
    ],
    driver: null,
    fleet: { id: 'flt_000000000001', name: 'Acme GmbH' },
    taxBreakdown: [{ taxRate: 0.19, netCents: 1000, taxCents: 190, grossCents: 1190 }],
    creditedInvoice: null,
    creditNote: null,
  } as unknown as InvoiceDetail;
}

describe('portal invoice routes', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(portalInvoiceRoutes);
    await app.ready();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  const auth = () => ({ authorization: `Bearer ${driverToken}` });

  it('refuses requests without a driver token', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal/invoices' });
    expect(res.statusCode).toBe(401);
  });

  it('scopes every read to the signed-in driver, never a fleet invoice or a draft', async () => {
    setupDbResults([], [{ count: 0 }]);
    const res = await app.inject({ method: 'GET', url: '/portal/invoices', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(eq)).toHaveBeenCalledWith(invoicesTable.driverId, DRIVER_ID);
    expect(vi.mocked(eq)).toHaveBeenCalledWith(invoicesTable.memberBilled, true);
    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(invoicesTable.status, ['draft', 'void']);
  });

  it('names the fleet only on member invoices', async () => {
    const base = {
      kind: 'invoice',
      status: 'issued',
      periodStart: null,
      periodEnd: null,
      creditedInvoiceId: null,
      issuedAt: new Date(),
      dueAt: null,
      paidAt: null,
      currency: 'EUR',
      subtotalCents: 100,
      taxCents: 19,
      totalCents: 119,
      createdAt: new Date(),
    };
    setupDbResults(
      [
        { ...base, id: 'inv_1', invoiceNumber: 'A', memberBilled: true, fleetName: 'Acme' },
        { ...base, id: 'inv_2', invoiceNumber: 'B', memberBilled: false, fleetName: null },
      ],
      [{ count: 2 }],
    );
    const res = await app.inject({ method: 'GET', url: '/portal/invoices', headers: auth() });
    const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
    expect(body.total).toBe(2);
    expect(body.data[0]?.['viaFleetName']).toBe('Acme');
    expect(body.data[1]?.['viaFleetName']).toBeNull();
    expect(body.data[0]).not.toHaveProperty('memberBilled');
  });

  it('answers 404 without reading an invoice outside the scope', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: `/portal/invoices/${INVOICE_ID}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(getInvoice).not.toHaveBeenCalled();

    const pdf = await app.inject({
      method: 'GET',
      url: `/portal/invoices/${INVOICE_ID}/pdf`,
      headers: auth(),
    });
    expect(pdf.statusCode).toBe(404);
    expect(generateInvoicePdf).not.toHaveBeenCalled();
  });

  it('returns the driver view of an own invoice', async () => {
    setupDbResults([{ id: INVOICE_ID }]);
    getInvoice.mockResolvedValue(memberDetail());
    const res = await app.inject({
      method: 'GET',
      url: `/portal/invoices/${INVOICE_ID}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['viaFleetName']).toBe('Acme GmbH');
    expect(body['billTo']).toMatchObject({ name: 'Erika Muster' });
    expect(body).not.toHaveProperty('paymentReference');
    expect(body).not.toHaveProperty('metadata');
  });

  it('streams the shared invoice PDF of an own invoice', async () => {
    setupDbResults([{ id: INVOICE_ID }]);
    const detail = memberDetail();
    getInvoice.mockResolvedValue(detail);
    generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.7'));
    const res = await app.inject({
      method: 'GET',
      url: `/portal/invoices/${INVOICE_ID}/pdf`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('INV-202611-0003.pdf');
    expect(generateInvoicePdf).toHaveBeenCalledWith(detail);
  });
});

describe('toPortalInvoiceDetail', () => {
  it('keeps only what the PDF prints from line metadata', () => {
    const view = toPortalInvoiceDetail(memberDetail());
    expect(view.lineItems[0]).toEqual({
      id: 1,
      sessionId: 'ses_000000000001',
      description: 'Charging session',
      quantity: '1',
      unitPriceCents: 1000,
      totalCents: 1000,
      taxCents: 190,
      taxRate: '0.19',
      kind: 'session',
      sessionDate: '2026-10-05',
      energyWh: 12000,
      stationName: 'Hof 1',
    });
  });

  it('shows no fleet and no bill-to on an ordinary driver invoice', () => {
    const detail = memberDetail();
    detail.invoice = { ...detail.invoice, fleetId: null, memberBilled: false, billTo: null };
    detail.fleet = null;
    const view = toPortalInvoiceDetail(detail);
    expect(view.viaFleetName).toBeNull();
    expect(view.billTo).toBeNull();
  });
});
