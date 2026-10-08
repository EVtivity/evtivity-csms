// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  client: vi.fn(() => Promise.resolve([])),
}));

import {
  formatPeriod,
  generateInvoicePdf,
  groupLinesByDriver,
  readBillTo,
} from '../invoice-pdf.service.js';
import type { InvoiceDetail } from '../invoice.service.js';

/** Uncompressed page content streams joined, decoded as WinAnsi (latin1) bytes. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const parts: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let data = Buffer.from(m[1] ?? '', 'latin1');
    try {
      data = inflateSync(data);
    } catch {
      // not compressed
    }
    const content = data.toString('latin1');
    if (!content.includes(' Tf')) continue;
    for (const t of content.matchAll(/<([0-9a-fA-F]*)>/g)) {
      parts.push(Buffer.from(t[1] ?? '', 'hex').toString('latin1'));
    }
  }
  return parts.join('');
}

const now = new Date('2026-10-02T09:00:00Z');

function line(
  id: number,
  sessionId: string,
  driverId: string | null,
  driverName: string,
  totalCents: number,
): InvoiceDetail['lineItems'][number] {
  return {
    id,
    invoiceId: 'inv_f1',
    sessionId,
    paymentRecordId: null,
    description: 'Charging session',
    quantity: '1',
    unitPriceCents: totalCents,
    totalCents,
    taxCents: Math.round(totalCents * 0.19),
    taxRate: '0.19',
    metadata: {
      kind: 'session',
      sessionDate: '2026-09-10',
      energyWh: 12000,
      ...(driverId != null ? { driverId } : {}),
      driverName,
      stationName: 'Depot CS-01',
    },
    createdAt: now,
  };
}

function fleetDetail(language: string | null = 'en'): InvoiceDetail {
  const lineItems = [
    line(1, 'ses_1', 'drv_a', 'Anna Berg', 1000),
    line(2, 'ses_2', 'drv_a', 'Anna Berg', 500),
    line(3, 'ses_3', 'drv_z', 'Zoe Ng', 2000),
  ];
  return {
    invoice: {
      id: 'inv_f1',
      invoiceNumber: 'INV-202610-0007',
      driverId: null,
      status: 'issued',
      kind: 'invoice',
      creditedInvoiceId: null,
      creditReason: null,
      paidAt: null,
      paymentReference: null,
      fleetId: 'flt_1',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      billTo: {
        name: 'Acme Logistics GmbH',
        street: 'Hafenstr. 1',
        city: 'Hamburg',
        state: null,
        zip: '20457',
        country: 'Germany',
        taxId: 'DE123456789',
      },
      language,
      sentAt: null,
      overdueNoticeSentAt: null,
      issuedAt: now,
      dueAt: now,
      currency: 'EUR',
      subtotalCents: 3500,
      taxCents: 665,
      totalCents: 4165,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    },
    lineItems,
    driver: null,
    fleet: { id: 'flt_1', name: 'Acme Logistics' },
    taxBreakdown: [{ taxRate: 0.19, netCents: 3500, taxCents: 665, grossCents: 4165 }],
    creditedInvoice: null,
    creditNote: null,
  };
}

describe('fleet invoice PDF helpers', () => {
  it('groups lines by driver in invoice order with net subtotals', () => {
    const groups = groupLinesByDriver(fleetDetail().lineItems);
    expect(groups.map((g) => [g.driverId, g.driverName, g.items.length, g.netCents])).toEqual([
      ['drv_a', 'Anna Berg', 2, 1500],
      ['drv_z', 'Zoe Ng', 1, 2000],
    ]);
  });

  it('keeps sessions of a deleted driver in one group without an id', () => {
    const groups = groupLinesByDriver([line(1, 'ses_1', null, '', 100)]);
    expect(groups).toEqual([expect.objectContaining({ driverId: null, driverName: '' })]);
  });

  it('reads the bill-to snapshot and ignores a driver invoice', () => {
    expect(readBillTo(fleetDetail().invoice.billTo)).toEqual({
      name: 'Acme Logistics GmbH',
      lines: ['Hafenstr. 1', '20457 Hamburg', 'Germany'],
      taxId: 'DE123456789',
    });
    expect(readBillTo(null)).toBeNull();
    expect(readBillTo({ street: 'x' })).toBeNull();
  });

  it('formats the period as month and year', () => {
    expect(formatPeriod('2026-09-01', 'en-US')).toBe('September 2026');
    expect(formatPeriod('2026-09-01', 'de-DE')).toBe('September 2026');
    expect(formatPeriod(null, 'en-US')).toBeNull();
  });
});

describe('generateInvoicePdf for a fleet invoice', () => {
  it('prints the bill-to block, the period and each driver with a subtotal', async () => {
    const text = pdfText(await generateInvoicePdf(fleetDetail()));
    expect(text).toContain('Acme Logistics GmbH');
    expect(text).toContain('20457 Hamburg');
    expect(text).toContain('VAT ID: DE123456789');
    expect(text).toContain('September 2026');
    expect(text).toContain('Subtotal Anna Berg');
    expect(text).toContain('Subtotal Zoe Ng');
    expect(text).toContain('Depot CS-01');
    expect(text.indexOf('Subtotal Anna Berg')).toBeLessThan(text.indexOf('Zoe Ng'));
  });

  it('renders in the language stored on the invoice', async () => {
    const text = pdfText(await generateInvoicePdf(fleetDetail('de')));
    expect(text).toContain('Zeitraum');
    expect(text).toContain('Zwischensumme Anna Berg');
    expect(text).toContain('USt-IdNr.: DE123456789');
  });
});
