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

/** Images drawn on the pages (`Do` operators), not image objects (a PNG alpha channel is its own). */
function imageCount(pdf: Buffer): number {
  const raw = pdf.toString('latin1');
  let count = 0;
  // Read each stream by its /Length: binary image data can hold "endstream".
  for (const m of raw.matchAll(/\/Length (\d+)[^>]*>>\s*stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const data = Buffer.from(raw.slice(start, start + Number(m[1])), 'latin1');
    let content: string;
    try {
      content = inflateSync(data).toString('latin1');
    } catch {
      content = data.toString('latin1');
    }
    count += (content.match(/\/I\d+ Do/g) ?? []).length;
  }
  return count;
}

/** Widths of the color images (a PNG alpha channel is a DeviceGray image of the same size). */
const imageWidths = (pdf: Buffer): number[] => [
  ...new Set(
    [...pdf.toString('latin1').matchAll(/\/Subtype \/Image[\s\S]*?\/Width (\d+)/g)].map((m) =>
      Number(m[1]),
    ),
  ),
];
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
  it('draws the default PDF logo when pdf.logo is unset', async () => {
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(1);
    // The company name shows in the "from" block.
    expect(pdfText(pdf)).toContain('EVtivity');
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores an empty company name and keeps the default', async () => {
    settingsRows.rows = [{ key: 'company.name', value: '' }];
    expect(pdfText(await generateInvoicePdf(detail()))).toContain('EVtivity');
  });

  it('does not use company.logo', async () => {
    settingsRows.rows = [{ key: 'company.logo', value: `data:image/png;base64,${PNG_B64}` }];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(1);
    // The default logo is rasterized 1000 pixels wide; the 1x1 PNG is not used.
    expect(imageWidths(pdf)).toEqual([1000]);
  });

  it('embeds a base64 PNG pdf.logo', async () => {
    settingsRows.rows = [
      { key: 'company.name', value: 'Acme Charging' },
      { key: 'pdf.logo', value: `data:image/png;base64,${PNG_B64}` },
    ];
    const pdf = await generateInvoicePdf(detail());
    expect(imageWidths(pdf)).toEqual([1]);
    expect(pdfText(pdf)).toContain('Acme Charging');
    expect(warn).not.toHaveBeenCalled();
  });

  it('rasterizes a URL-encoded or base64 SVG pdf.logo', async () => {
    settingsRows.rows = [
      { key: 'pdf.logo', value: `data:image/svg+xml,${encodeURIComponent(SVG)}` },
    ];
    expect(imageCount(await generateInvoicePdf(detail()))).toBe(1);
    settingsRows.rows = [
      {
        key: 'pdf.logo',
        value: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
      },
    ];
    expect(imageCount(await generateInvoicePdf(detail()))).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-base64 PNG', `data:image/png,${PNG_B64}`],
    ['an unsupported image type', `data:image/gif;base64,${PNG_B64}`],
    ['a value that is not a data URI', 'https://example.com/logo.png'],
    ['an SVG that does not parse', 'data:image/svg+xml,not-svg'],
  ])('warns and draws the default logo for %s', async (_label, logo) => {
    settingsRows.rows = [{ key: 'pdf.logo', value: logo }];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'pdf.logo is not a valid PNG, JPEG or SVG data URI, using the default logo',
    );
  });

  it('warns and draws the default logo when pdfkit rejects the image bytes', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not an image'),
    ]);
    settingsRows.rows = [
      { key: 'pdf.logo', value: `data:image/png;base64,${broken.toString('base64')}` },
    ];
    const pdf = await generateInvoicePdf(detail());
    expect(imageCount(pdf)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() as unknown }),
      'pdfkit rejected the PDF logo, using the default logo',
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
