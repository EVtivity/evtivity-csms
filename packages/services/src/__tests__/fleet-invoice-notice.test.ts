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
  dispatchSystemNotification: vi.fn((_sql: unknown, _event: string, to: { email: string }) =>
    Promise.resolve({ delivered: [{ channel: 'email', recipient: to.email }] }),
  ),
  dispatchDriverNotification: vi.fn(() =>
    Promise.resolve({ delivered: [{ channel: 'email', recipient: 'mia@example.com' }] }),
  ),
}));

vi.mock('../invoice-audit.js', () => ({
  writeInvoiceSentAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../invoice.service.js', () => ({
  getInvoice: vi.fn(() => Promise.resolve(h.detail)),
}));

vi.mock('../invoice-pdf.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../invoice-pdf.service.js')>()),
  generateInvoicePdf: vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.3'))),
}));

import { dispatchDriverNotification, dispatchSystemNotification } from '@evtivity/lib';
import { loadFleetBillingContacts } from '@evtivity/database';
import { generateInvoicePdf } from '../invoice-pdf.service.js';
import { writeInvoiceSentAudit } from '../invoice-audit.js';
import {
  FLEET_CREDIT_NOTE_EVENT,
  FLEET_INVOICE_EVENT,
  MEMBER_CREDIT_NOTE_EVENT,
  MEMBER_INVOICE_EVENT,
  fleetInvoiceVariables,
  sendAccountInvoiceEmail,
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
      memberBilled: false,
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
const audit = {
  actor: { actor: 'operator' as const, actorUserId: 'usr_1' },
  log: { warn: vi.fn() },
};

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
      invoiceId: 'inv_f1',
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

describe('sendAccountInvoiceEmail', () => {
  it('emails each billing contact once with the PDF attached, in the invoice language', async () => {
    const result = await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit);

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

  it('audits the send as invoice_sent with the accepted deliveries', async () => {
    await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit);
    expect(writeInvoiceSentAudit).toHaveBeenCalledWith(
      {
        invoiceId: 'inv_f1',
        invoiceNumber: 'INV-202610-0007',
        eventType: FLEET_INVOICE_EVENT,
        delivered: [
          { channel: 'email', recipient: 'ap@acme.test' },
          { channel: 'email', recipient: 'cfo@acme.test' },
        ],
        resend: false,
        actor: audit.actor,
      },
      audit.log,
    );
  });

  it('audits a resend of an invoice emailed before', async () => {
    h.detail = detail({ sentAt: issuedAt });
    await sendAccountInvoiceEmail('inv_f1', 'resend', deps, audit);
    expect(vi.mocked(writeInvoiceSentAudit).mock.calls[0]?.[0]).toMatchObject({ resend: true });
  });

  it('sends nothing when the issue was emailed already', async () => {
    h.markRows = [];
    expect(await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).toEqual({
      status: 'already_sent',
    });
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
    expect(writeInvoiceSentAudit).not.toHaveBeenCalled();
  });

  it('resends without the once guard', async () => {
    await sendAccountInvoiceEmail('inv_f1', 'resend', deps, audit);
    expect(h.statements[0]).not.toContain('sent_at IS NULL');
    expect(dispatchSystemNotification).toHaveBeenCalledTimes(2);
  });

  it('sends the credit note event for a credit note', async () => {
    h.detail = detail({ kind: 'credit_note', invoiceNumber: 'CN-202610-0001', totalCents: -4165 });
    await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit);
    expect(vi.mocked(dispatchSystemNotification).mock.calls[0]?.[1]).toBe(FLEET_CREDIT_NOTE_EVENT);
  });

  it('marks nothing and sends nothing without billing contacts', async () => {
    h.contacts = { emails: [], language: 'en' };
    expect(await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).toEqual({
      status: 'no_contacts',
    });
    expect(generateInvoicePdf).not.toHaveBeenCalled();
    expect(h.statements).toHaveLength(0);
  });

  it('skips a driver invoice and an unknown invoice', async () => {
    h.detail = detail({ fleetId: null });
    expect(await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).toEqual({
      status: 'not_fleet',
    });
    h.detail = null;
    expect(await sendAccountInvoiceEmail('inv_x', 'once', deps, audit)).toEqual({
      status: 'not_found',
    });
  });

  it('renders the PDF before it marks the invoice sent', async () => {
    vi.mocked(generateInvoicePdf).mockRejectedValueOnce(new Error('font missing'));
    await expect(sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).rejects.toThrow(
      'font missing',
    );
    expect(h.statements).toHaveLength(0);
  });
});

describe('sendAccountInvoiceEmail for a member invoice', () => {
  const memberDriver = { id: 'drv_1', firstName: 'Mia', lastName: 'M', email: 'mia@example.com' };

  beforeEach(() => {
    h.detail = { ...detail({ memberBilled: true, driverId: 'drv_1' }), driver: memberDriver };
  });

  it('emails the driver only, with the PDF and no SMS, never the fleet contacts', async () => {
    const result = await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit);

    expect(result).toEqual({ status: 'sent', recipients: 1 });
    expect(loadFleetBillingContacts).not.toHaveBeenCalled();
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER_INVOICE_EVENT,
      'drv_1',
      expect.objectContaining({ invoiceId: 'inv_f1', invoiceNumber: 'INV-202610-0007' }),
      ['/templates'],
      expect.anything(),
      {
        attachments: [
          {
            filename: 'INV-202610-0007.pdf',
            content: Buffer.from('%PDF-1.3'),
            contentType: 'application/pdf',
          },
        ],
        sms: false,
      },
    );
    expect(h.statements[0]).toContain('sent_at IS NULL');
    expect(vi.mocked(writeInvoiceSentAudit).mock.calls[0]?.[0]).toMatchObject({
      eventType: MEMBER_INVOICE_EVENT,
      delivered: [{ channel: 'email', recipient: 'mia@example.com' }],
      resend: false,
    });
  });

  it('sends the member credit note event for the credit note of a member invoice', async () => {
    h.detail = {
      ...detail({
        memberBilled: true,
        kind: 'credit_note',
        invoiceNumber: 'CN-202610-0001',
        totalCents: -4165,
      }),
      driver: memberDriver,
    };
    await sendAccountInvoiceEmail('inv_f1', 'resend', deps, audit);
    expect(vi.mocked(dispatchDriverNotification).mock.calls[0]?.[1]).toBe(MEMBER_CREDIT_NOTE_EVENT);
    expect(h.statements[0]).not.toContain('sent_at IS NULL');
  });

  it('marks nothing when the driver is gone or has no email', async () => {
    h.detail = { ...detail({ memberBilled: true, driverId: null }), driver: null };
    expect(await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).toEqual({
      status: 'no_driver',
    });
    h.detail = {
      ...detail({ memberBilled: true }),
      driver: { ...memberDriver, email: null },
    };
    expect(await sendAccountInvoiceEmail('inv_f1', 'resend', deps, audit)).toEqual({
      status: 'no_email',
    });
    expect(generateInvoicePdf).not.toHaveBeenCalled();
    expect(h.statements).toHaveLength(0);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('sends nothing when the issue was emailed already', async () => {
    h.markRows = [];
    expect(await sendAccountInvoiceEmail('inv_f1', 'once', deps, audit)).toEqual({
      status: 'already_sent',
    });
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });
});
