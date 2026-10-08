// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn, settingsRows } = vi.hoisted(() => ({
  warn: vi.fn(),
  settingsRows: { rows: [] as Array<{ key: string; value: unknown }> },
}));

vi.mock('@evtivity/database', () => ({
  client: vi.fn(() => Promise.resolve(settingsRows.rows)),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { generateInvoicePdf } from '../invoice-pdf.service.js';
import type { InvoiceDetail } from '../invoice.service.js';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

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

const imageCount = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
const pageCount = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

function detail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  const now = new Date('2026-06-04T12:00:00Z');
  const base: InvoiceDetail = {
    invoice: {
      id: 'inv_1',
      invoiceNumber: 'INV-202606-0042',
      driverId: 'drv_1',
      status: 'issued',
      kind: 'invoice',
      creditedInvoiceId: null,
      creditReason: null,
      paidAt: null,
      paymentReference: null,
      fleetId: null,
      periodStart: null,
      periodEnd: null,
      billTo: null,
      language: null,
      sentAt: null,
      overdueNoticeSentAt: null,
      issuedAt: now,
      dueAt: now,
      currency: 'USD',
      subtotalCents: 300,
      taxCents: 0,
      totalCents: 300,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    },
    lineItems: [
      {
        id: 1,
        invoiceId: 'inv_1',
        sessionId: 'ses_1',
        paymentRecordId: null,
        description: 'Charging session',
        quantity: '1',
        unitPriceCents: 300,
        totalCents: 300,
        taxCents: 0,
        taxRate: '0',
        metadata: null,
        createdAt: now,
      },
    ],
    driver: {
      id: 'drv_1',
      firstName: 'Jana',
      lastName: 'Weber',
      email: null,
      language: 'en',
    },
    creditedInvoice: null,
    creditNote: null,
    fleet: null,
    taxBreakdown: [{ taxRate: 0, netCents: 300, taxCents: 0, grossCents: 300 }],
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  warn.mockClear();
  settingsRows.rows = [];
});

describe('generateInvoicePdf branding', () => {
  it('uses the EVtivity wordmark when no company settings exist', async () => {
    const pdf = await generateInvoicePdf(detail());
    expect(pdfText(pdf)).toContain('EVtivity');
    expect(imageCount(pdf)).toBe(0);
  });

  it('ignores an empty company name and keeps the default', async () => {
    settingsRows.rows = [{ key: 'company.name', value: '' }];
    expect(pdfText(await generateInvoicePdf(detail()))).toContain('EVtivity');
  });

  it('embeds a base64 PNG logo', async () => {
    settingsRows.rows = [
      { key: 'company.name', value: 'Acme Charging' },
      { key: 'company.logo', value: `data:image/png;base64,${PNG_B64}` },
    ];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBeGreaterThan(0);
    // The company name still shows in the "from" block.
    expect(pdfText(pdf)).toContain('Acme Charging');
    expect(warn).not.toHaveBeenCalled();
  });

  it('rasterizes a URL-encoded SVG logo', async () => {
    settingsRows.rows = [
      { key: 'company.logo', value: `data:image/svg+xml,${encodeURIComponent(SVG)}` },
    ];
    expect(imageCount(await generateInvoicePdf(detail()))).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rasterizes a base64 SVG logo', async () => {
    settingsRows.rows = [
      {
        key: 'company.logo',
        value: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
      },
    ];
    expect(imageCount(await generateInvoicePdf(detail()))).toBeGreaterThan(0);
  });

  it.each([
    ['a non-base64 PNG', `data:image/png,${PNG_B64}`],
    ['an unsupported image type', `data:image/gif;base64,${PNG_B64}`],
    ['a value that is not a data URI', 'https://example.com/logo.png'],
  ])('falls back to the wordmark for %s', async (_label, logo) => {
    settingsRows.rows = [
      { key: 'company.name', value: 'Acme Charging' },
      { key: 'company.logo', value: logo },
    ];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(0);
    expect(pdfText(pdf)).toContain('Acme Charging');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and uses the wordmark when the SVG cannot be rasterized', async () => {
    settingsRows.rows = [{ key: 'company.logo', value: 'data:image/svg+xml,not-svg' }];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() as unknown }),
      'Failed to decode invoice logo, falling back to wordmark',
    );
  });

  it('warns and uses the wordmark when pdfkit rejects the image bytes', async () => {
    settingsRows.rows = [
      { key: 'company.name', value: 'Acme Charging' },
      {
        key: 'company.logo',
        value: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
      },
    ];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(0);
    expect(pdfText(pdf)).toContain('Acme Charging');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() as unknown }),
      'pdfkit rejected invoice logo, falling back to wordmark',
    );
  });
});

describe('generateInvoicePdf content', () => {
  it('prints the driver email when present', async () => {
    const d = detail();
    const pdf = await generateInvoicePdf({
      ...d,
      driver: { ...d.driver!, email: 'jana@example.com' },
    });
    expect(pdfText(pdf)).toContain('jana@example.com');
  });

  it('prints a dash for missing and invalid dates', async () => {
    const d = detail();
    const withDates = await generateInvoicePdf({
      ...d,
      invoice: { ...d.invoice, issuedAt: null, dueAt: 'not-a-date' },
    } as unknown as InvoiceDetail);
    // pdfkit writes the em dash as WinAnsi 0x97.
    expect((pdfText(withDates).match(/\u0097/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const normal = await generateInvoicePdf(d);
    expect(pdfText(normal)).toContain('Jun 4, 2026');
  });

  it('breaks long invoices across pages', async () => {
    const d = detail();
    const item = d.lineItems[0]!;
    const lineItems = Array.from({ length: 60 }, (_, i) => ({
      ...item,
      id: i + 1,
      description: `Session ${String(i + 1)}`,
    }));
    const pdf = await generateInvoicePdf({ ...d, lineItems });
    expect(pageCount(pdf)).toBeGreaterThan(1);
    const text = pdfText(pdf);
    expect(text).toContain('Session 1');
    expect(text).toContain('Session 60');
  });
});
