// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn, settingsRows } = vi.hoisted(() => ({
  warn: vi.fn(),
  settingsRows: { rows: [] as Array<{ key: string; value: unknown }> },
}));

/**
 * A stand-in for every query builder, table and column: callable, chainable
 * and awaitable (resolving to no rows), so the report generators run against
 * an empty database. `client` returns the settings rows of the test.
 */
function anything(): unknown {
  const target = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve([]);
      }
      if (typeof prop === 'symbol') return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('@evtivity/database', () => {
  const settingsClient = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const keys = values.filter((v): v is string => typeof v === 'string');
    const text = strings.join('?');
    return Promise.resolve(
      settingsRows.rows.filter((row) => keys.includes(row.key) || text.includes(`'${row.key}'`)),
    );
  });
  return new Proxy(
    { client: settingsClient },
    {
      get: (target, prop) => {
        if (prop === 'client') return target.client;
        if (prop === 'getSystemTimezone') return () => Promise.resolve('UTC');
        if (prop === 'getCompanyCurrency') return () => Promise.resolve('EUR');
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return anything();
      },
      has: () => true,
    },
  );
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  defaultPdfLogoPng,
  drawPdfFooter,
  layoutPdfFooter,
  loadPdfBranding,
  resolvePdfLogo,
  type PdfBranding,
} from '../pdf-branding.js';
import { generateInvoicePdf } from '../invoice-pdf.service.js';
import type { InvoiceDetail } from '../invoice.service.js';
import { PdfReportBuilder } from '../report-generators/pdf-builder.js';
import { generateRevenueReport } from '../report-generators/revenue-report.js';
import { generateEnergyReport } from '../report-generators/energy-report.js';
import { generateSessionsReport } from '../report-generators/sessions-report.js';
import { generateUtilizationReport } from '../report-generators/utilization-report.js';
import { generateStationHealthReport } from '../report-generators/station-health-report.js';
import { generateSustainabilityReport } from '../report-generators/sustainability-report.js';
import { generateDriverActivityReport } from '../report-generators/driver-activity-report.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FOOTER = 'Acme Charging GmbH\nHauptstrasse 1, 10115 Berlin';
const PAGE_WIDTH_PORTRAIT = 595.28;
const PAGE_WIDTH_LANDSCAPE = 841.89;
const PAGE_HEIGHT_LANDSCAPE = 595.28;
const MARGIN = 50;

interface TextRun {
  x: number;
  y: number;
  size: number;
  text: string;
}

interface Page {
  runs: TextRun[];
  /** Image draws: x, y of the bottom edge from the page top, width, height. */
  images: Array<{ x: number; y: number; width: number; height: number }>;
}

/** The content streams of a PDF, read by /Length (image data can hold "endstream"). */
function contentStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/\/Length (\d+)[^>]*>>\s*stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const data = Buffer.from(raw.slice(start, start + Number(m[1])), 'latin1');
    let content: string;
    try {
      content = inflateSync(data).toString('latin1');
    } catch {
      content = data.toString('latin1');
    }
    if (content.includes(' Tf') || content.includes(' Do')) out.push(content);
  }
  return out;
}

/** Text runs (Helvetica, WinAnsi) and image draws of each page, in page order. */
function pages(pdf: Buffer): Page[] {
  return contentStreams(pdf).map((content) => {
    const runs: TextRun[] = [];
    for (const m of content.matchAll(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n\/F\d+ ([\d.]+) Tf\n\[(.*?)\] TJ/g,
    )) {
      const text = [...(m[4] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)]
        .map((h) => Buffer.from(h[1] ?? '', 'hex').toString('latin1'))
        .join('');
      runs.push({ x: Number(m[1]), y: Number(m[2]), size: Number(m[3]), text });
    }
    const images = [
      ...content.matchAll(/([\d.]+) 0 0 -([\d.]+) ([\d.]+) ([\d.]+) cm\n\/I\d+ Do/g),
    ].map((m) => ({
      width: Number(m[1]),
      height: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
    }));
    return { runs, images };
  });
}

function helveticaWidth(text: string, size: number): number {
  return new PDFDocument().font('Helvetica').fontSize(size).widthOfString(text);
}

/**
 * Every page has the footer: each line in 8 pt, centered between the margins,
 * below all other text. The first page has the logo at the top left.
 */
function expectBranded(pdf: Buffer, pageWidth: number, minPages = 1): void {
  const all = pages(pdf);
  expect(all.length).toBeGreaterThanOrEqual(minPages);
  const lines = FOOTER.split('\n');
  for (const [index, page] of all.entries()) {
    const footerRuns = page.runs.filter((run) => lines.includes(run.text));
    expect(footerRuns.map((run) => run.text)).toEqual(lines);
    for (const run of footerRuns) {
      expect(run.size).toBe(8);
      const width = helveticaWidth(run.text, 8);
      const center = run.x + width / 2;
      expect(Math.abs(center - pageWidth / 2)).toBeLessThan(1);
    }
    // The footer is the lowest text on the page (y grows upward in the PDF).
    const lowestOther = Math.min(
      ...page.runs.filter((run) => !lines.includes(run.text)).map((run) => run.y),
      Number.POSITIVE_INFINITY,
    );
    for (const run of footerRuns) expect(run.y).toBeLessThan(lowestOther);
    if (index === 0) {
      expect(page.images).toHaveLength(1);
      const logo = page.images[0]!;
      expect(logo.x).toBeCloseTo(MARGIN, 0);
    }
  }
}

function detail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  const now = new Date('2026-06-04T12:00:00Z');
  const item = {
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
  };
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
    lineItems: Array.from({ length: 70 }, (_, i) => ({ ...item, id: i + 1 })),
    driver: { id: 'drv_1', firstName: 'Jana', lastName: 'Weber', email: null, language: 'en' },
    creditedInvoice: null,
    creditNote: null,
    fleet: null,
    taxBreakdown: [{ taxRate: 0, netCents: 300, taxCents: 0, grossCents: 300 }],
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  warn.mockClear();
  settingsRows.rows = [{ key: 'pdf.footer', value: FOOTER }];
});

describe('loadPdfBranding', () => {
  it('uses the default logo and the default footer when nothing is set', async () => {
    settingsRows.rows = [];
    const branding = await loadPdfBranding();
    expect(branding.isDefaultLogo).toBe(true);
    expect(branding.logo.equals(defaultPdfLogoPng())).toBe(true);
    expect(branding.footer).toBe('www.evtivity.com');
  });

  it('draws no footer when the operator cleared it', async () => {
    settingsRows.rows = [{ key: 'pdf.footer', value: '' }];
    expect((await loadPdfBranding()).footer).toBe('');
  });

  it('reads the logo and the footer', async () => {
    settingsRows.rows = [
      { key: 'pdf.logo', value: `data:image/png;base64,${PNG_B64}` },
      { key: 'pdf.footer', value: 'Line 1\r\nLine 2' },
    ];
    const branding = await loadPdfBranding();
    expect(branding.isDefaultLogo).toBe(false);
    expect(branding.logo.toString('base64')).toBe(PNG_B64);
    expect(branding.footer).toBe('Line 1\nLine 2');
  });

  it('leaves out a footer that is not valid and warns', async () => {
    settingsRows.rows = [{ key: 'pdf.footer', value: 'x'.repeat(501) }];
    expect((await loadPdfBranding()).footer).toBe('');
    expect(warn).toHaveBeenCalledWith('pdf.footer is not a valid footer, leaving the footer out');
  });

  it('rasterizes the default logo as a wide PNG', () => {
    const png = defaultPdfLogoPng();
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // IHDR width and height: the mark and the wordmark side by side.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(1000);
    expect(width / height).toBeGreaterThan(3);
  });
});

describe('resolvePdfLogo', () => {
  it('renders an SVG after sanitizing it and accepts a JPEG copied from company.logo', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/><script>x</script></svg>';
    const png = resolvePdfLogo(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    expect(png?.readUInt32BE(16)).toBe(1000);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect(resolvePdfLogo(`data:image/jpeg;base64,${jpeg.toString('base64')}`)).toEqual(jpeg);
    expect(resolvePdfLogo('')).toBeNull();
    expect(resolvePdfLogo(null)).toBeNull();
  });
});

describe('PDF footer layout', () => {
  it('reserves no space without a footer and wraps a long line', () => {
    const doc = new PDFDocument({ size: 'A4' });
    expect(layoutPdfFooter(doc, '', 495).reserve).toBe(0);
    const one = layoutPdfFooter(doc, 'short', 495);
    const wrapped = layoutPdfFooter(doc, 'word '.repeat(60).trim(), 495);
    expect(wrapped.height).toBeGreaterThan(one.height * 2);
    expect(one.font).toBe('Helvetica');
  });

  it('draws nothing for an empty footer', () => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true });
    const switchToPage = vi.spyOn(doc, 'switchToPage');
    drawPdfFooter(doc, layoutPdfFooter(doc, '', 495), MARGIN, 495);
    expect(switchToPage).not.toHaveBeenCalled();
  });
});

describe('every PDF generator draws the logo and the centered footer on every page', () => {
  it('a driver invoice over several pages', async () => {
    const pdf = await generateInvoicePdf(detail());
    expectBranded(pdf, PAGE_WIDTH_PORTRAIT, 2);
  });

  it('a credit note', async () => {
    const base = detail({ lineItems: detail().lineItems.slice(0, 1) });
    const pdf = await generateInvoicePdf({
      ...base,
      invoice: { ...base.invoice, kind: 'credit_note', creditReason: 'Wrong tariff' },
      creditedInvoice: { ...base.invoice, invoiceNumber: 'INV-1', paidAt: new Date() },
    } as unknown as InvoiceDetail);
    expectBranded(pdf, PAGE_WIDTH_PORTRAIT);
  });

  it('a fleet invoice', async () => {
    const base = detail();
    const pdf = await generateInvoicePdf({
      ...base,
      invoice: {
        ...base.invoice,
        fleetId: 'flt_1',
        periodStart: '2026-05-01',
        billTo: { name: 'Acme Fleet', street: 'Main 1', city: 'Berlin' },
      },
      lineItems: base.lineItems.map((item, i) => ({
        ...item,
        metadata: { driverId: `drv_${String(i % 3)}`, driverName: `Driver ${String(i % 3)}` },
      })),
      driver: null,
    });
    expectBranded(pdf, PAGE_WIDTH_PORTRAIT, 2);
  });

  it('the report builder over several pages', async () => {
    const branding: PdfBranding = await loadPdfBranding();
    const rows = Array.from({ length: 80 }, (_, i) => [`CS-${String(i)}`, String(i)]);
    const pdf = await new PdfReportBuilder('en', branding)
      .addTitle('Sessions')
      .addTable(['Station', 'kWh'], rows)
      .build();
    expectBranded(pdf, PAGE_WIDTH_LANDSCAPE, 3);
    // The title baseline sits below the logo. Text runs count y from the page
    // bottom; image draws from the top (pdfkit flips the page).
    const first = pages(pdf)[0]!;
    const title = first.runs.find((run) => run.text === 'Sessions')!;
    const logo = first.images[0]!;
    expect(PAGE_HEIGHT_LANDSCAPE - title.y).toBeGreaterThan(logo.y);
  });

  it.each([
    ['revenue', generateRevenueReport],
    ['energy', generateEnergyReport],
    ['sessions', generateSessionsReport],
    ['utilization', generateUtilizationReport],
    ['station health', generateStationHealthReport],
    ['sustainability', generateSustainabilityReport],
    ['driver activity', generateDriverActivityReport],
  ] as const)('the %s report', async (_name, generate) => {
    const { data } = await generate({}, 'pdf', 'en', null);
    expectBranded(data, PAGE_WIDTH_LANDSCAPE);
  });

  it('no other module renders a PDF', () => {
    // A new PDF generator must draw the branding: route it through
    // PdfReportBuilder or the invoice renderer, or add it to this test.
    const root = fileURLToPath(new URL('../', import.meta.url));
    const renderers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) walk(`${path}/`);
        else if (entry.name.endsWith('.ts') && /from 'pdfkit'/.test(readFileSync(path, 'utf8'))) {
          renderers.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    expect(renderers.sort()).toEqual([
      'invoice-pdf.service.ts',
      'report-generators/pdf-builder.ts',
    ]);
  });
});
