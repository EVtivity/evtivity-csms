// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface NoticeState {
  contacts: { emails: string[]; language: string | null };
  // Rows the sent_at update returns (empty: already sent).
  markRows: Array<{ id: string }>;
  statements: string[];
  detail: unknown;
}

const h = vi.hoisted(
  (): NoticeState => ({
    contacts: { emails: [], language: 'de' },
    markRows: [{ id: 'inv_f1' }],
    statements: [],
    detail: null,
  }),
);

vi.mock('@evtivity/database', () => ({
  client: vi.fn((strings: TemplateStringsArray) => {
    h.statements.push(strings.join('?').replace(/\s+/g, ' '));
    return Promise.resolve(h.markRows);
  }),
  getSystemTimezone: vi.fn(() => Promise.resolve('Europe/Berlin')),
  loadFleetBillingContacts: vi.fn(() => Promise.resolve(h.contacts)),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchSystemNotification: vi.fn(() => Promise.resolve()),
}));

vi.mock('../invoice.service.js', () => ({
  getInvoice: vi.fn(() => Promise.resolve(h.detail)),
}));

vi.mock('../invoice-pdf.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../invoice-pdf.service.js')>()),
  generateInvoicePdf: vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.3'))),
}));

import { dispatchSystemNotification } from '@evtivity/lib';
import { generateInvoicePdf } from '../invoice-pdf.service.js';
import {
  FLEET_CREDIT_NOTE_EVENT,
  FLEET_INVOICE_EVENT,
  fleetInvoiceVariables,
  sendFleetInvoiceEmail,
} from '../fleet-invoice-notice.js';

const issuedAt = new Date('2026-10-02T09:00:00Z');

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invoice: {
      id: 'inv_f1',
      invoiceNumber: 'INV-202610-0007',
      kind: 'invoice',
      fleetId: 'flt_1',
      periodStart: '2026-09-01',
      language: 'de',
      issuedAt,
      dueAt: new Date('2026-10-16T09:00:00Z'),
      totalCents: 4165,
      currency: 'EUR',
      creditReason: null,
      ...overrides,
    },
    lineItems: [{ sessionId: 'ses_1' }, { sessionId: 'ses_1' }, { sessionId: 'ses_2' }],
    driver: null,
    fleet: { id: 'flt_1', name: 'Acme Logistics' },
    taxBreakdown: [],
    creditedInvoice: null,
    creditNote: null,
  };
}

const deps = { templatesDirs: ['/templates'] };

beforeEach(() => {
  vi.clearAllMocks();
  h.contacts = { emails: ['ap@acme.test', 'cfo@acme.test'], language: 'en' };
  h.markRows = [{ id: 'inv_f1' }];
  h.statements = [];
  h.detail = detail();
});

describe('fleetInvoiceVariables', () => {
  it('describes the invoice in the language stored on it', () => {
    const vars = fleetInvoiceVariables(detail() as never);
    expect(vars).toMatchObject({
      fleetName: 'Acme Logistics',
      invoiceNumber: 'INV-202610-0007',
      periodLabel: 'September 2026',
      issuedAt: issuedAt.toISOString(),
      totalCents: 4165,
      currency: 'EUR',
      sessionCount: 2,
    });
  });

  it('describes a credit note with the credited invoice and a positive amount', () => {
    const vars = fleetInvoiceVariables({
      ...detail({
        kind: 'credit_note',
        invoiceNumber: 'CN-202610-0001',
        totalCents: -4165,
        creditReason: 'Wrong tariff',
      }),
      creditedInvoice: { invoiceNumber: 'INV-202610-0007', paidAt: issuedAt },
    } as never);
    expect(vars).toMatchObject({
      creditNoteNumber: 'CN-202610-0001',
      invoiceNumber: 'INV-202610-0007',
      creditReason: 'Wrong tariff',
      totalCents: 4165,
      wasPaid: true,
    });
  });
});

describe('sendFleetInvoiceEmail', () => {
  it('emails each billing contact once with the PDF attached, in the invoice language', async () => {
    const result = await sendFleetInvoiceEmail('inv_f1', 'once', deps);

    expect(result).toEqual({ status: 'sent', recipients: 2 });
    expect(dispatchSystemNotification).toHaveBeenCalledTimes(2);
    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      FLEET_INVOICE_EVENT,
      { email: 'ap@acme.test', language: 'de', timezone: 'Europe/Berlin' },
      expect.objectContaining({ invoiceNumber: 'INV-202610-0007' }),
      ['/templates'],
      [
        {
          filename: 'INV-202610-0007.pdf',
          content: Buffer.from('%PDF-1.3'),
          contentType: 'application/pdf',
        },
      ],
    );
    expect(h.statements[0]).toContain('sent_at IS NULL');
  });

  it('sends nothing when the issue was emailed already', async () => {
    h.markRows = [];
    expect(await sendFleetInvoiceEmail('inv_f1', 'once', deps)).toEqual({
      status: 'already_sent',
    });
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('resends without the once guard', async () => {
    await sendFleetInvoiceEmail('inv_f1', 'resend', deps);
    expect(h.statements[0]).not.toContain('sent_at IS NULL');
    expect(dispatchSystemNotification).toHaveBeenCalledTimes(2);
  });

  it('sends the credit note event for a credit note', async () => {
    h.detail = detail({ kind: 'credit_note', invoiceNumber: 'CN-202610-0001', totalCents: -4165 });
    await sendFleetInvoiceEmail('inv_f1', 'once', deps);
    expect(vi.mocked(dispatchSystemNotification).mock.calls[0]?.[1]).toBe(FLEET_CREDIT_NOTE_EVENT);
  });

  it('marks nothing and sends nothing without billing contacts', async () => {
    h.contacts = { emails: [], language: 'en' };
    expect(await sendFleetInvoiceEmail('inv_f1', 'once', deps)).toEqual({
      status: 'no_contacts',
    });
    expect(generateInvoicePdf).not.toHaveBeenCalled();
    expect(h.statements).toHaveLength(0);
  });

  it('skips a driver invoice and an unknown invoice', async () => {
    h.detail = detail({ fleetId: null });
    expect(await sendFleetInvoiceEmail('inv_f1', 'once', deps)).toEqual({ status: 'not_fleet' });
    h.detail = null;
    expect(await sendFleetInvoiceEmail('inv_x', 'once', deps)).toEqual({ status: 'not_found' });
  });

  it('renders the PDF before it marks the invoice sent', async () => {
    vi.mocked(generateInvoicePdf).mockRejectedValueOnce(new Error('font missing'));
    await expect(sendFleetInvoiceEmail('inv_f1', 'once', deps)).rejects.toThrow('font missing');
    expect(h.statements).toHaveLength(0);
  });
});
