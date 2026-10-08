// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@evtivity/database', () => ({
  client: vi.fn(() => Promise.resolve([{ key: 'company.name', value: 'Acme Charging' }])),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Noto Sans CJK subsets (OFL, fixtures/noto-sans-cjk/OFL.txt) with the same
// collection layout and PostScript names as the fonts-noto-cjk files.
vi.mock('../pdf-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/pdf-fonts')>()),
  CJK_FONT_FILES: {
    regular: fileURLToPath(
      new URL('./fixtures/noto-sans-cjk/NotoSansCJK-Regular-subset.ttc', import.meta.url),
    ),
    bold: fileURLToPath(
      new URL('./fixtures/noto-sans-cjk/NotoSansCJK-Bold-subset.ttc', import.meta.url),
    ),
  },
}));

import { generateInvoicePdf, resolveInvoicePdfLanguage } from '../invoice-pdf.service.js';
import { INVOICE_LABELS, INVOICE_LANGUAGES, describeLineItem } from '../invoice-labels.js';
import type { InvoiceDetail } from '../invoice.service.js';

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function pdfObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const objectRe = /(\d+) 0 obj\s*([\s\S]*?)\nendobj/g;
  for (let m = objectRe.exec(raw); m != null; m = objectRe.exec(raw)) {
    const body = m[2] ?? '';
    const s = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    let stream: Buffer | null = null;
    if (s != null) {
      const data = Buffer.from(s[1] ?? '', 'latin1');
      try {
        stream = inflateSync(data);
      } catch {
        stream = data;
      }
    }
    objects.set(Number(m[1]), { dict: s != null ? body.slice(0, s.index) : body, stream });
  }
  return objects;
}

/** Glyph code to text, from a pdfkit ToUnicode CMap (`<start> <end> [<utf16> ...]`). */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const range of cmap.matchAll(/<([0-9a-fA-F]{4})> <[0-9a-fA-F]{4}> \[([^\]]*)\]/g)) {
    let code = parseInt(range[1] ?? '0', 16);
    for (const entry of (range[2] ?? '').matchAll(/<([0-9a-fA-F ]+)>/g)) {
      const units = (entry[1] ?? '').split(' ').map((hex) => parseInt(hex, 16));
      map.set(code++, String.fromCharCode(...units));
    }
  }
  return map;
}

interface PdfContent {
  /** The text drawn on the pages, in drawing order. */
  text: string;
  /** BaseFont names of the fonts the pages use. */
  fonts: string[];
  /** Characters drawn with the .notdef glyph (code 0 of an embedded subset). */
  missingGlyphs: string[];
}

/**
 * Text drawn on pdfkit pages. Embedded fonts (Identity-H) are decoded through
 * their ToUnicode CMap; the standard fonts are WinAnsi bytes, decoded as latin1.
 */
function pdfContent(pdf: Buffer): PdfContent {
  const objects = pdfObjects(pdf);
  const fontRefs = new Map<string, number>();
  for (const { dict } of objects.values()) {
    for (const ref of dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      fontRefs.set(ref[1] ?? '', Number(ref[2]));
    }
  }
  const baseFonts = new Map<string, string>();
  const toUnicode = new Map<string, Map<number, string>>();
  for (const [id, objectId] of fontRefs) {
    const dict = objects.get(objectId)?.dict ?? '';
    baseFonts.set(id, /\/BaseFont \/(\S+)/.exec(dict)?.[1] ?? '');
    const cmapRef = /\/ToUnicode (\d+) 0 R/.exec(dict)?.[1];
    const cmap = cmapRef != null ? objects.get(Number(cmapRef))?.stream : null;
    if (cmap != null) toUnicode.set(id, parseToUnicode(cmap.toString('latin1')));
  }

  const parts: string[] = [];
  const missingGlyphs: string[] = [];
  for (const { stream } of objects.values()) {
    const content = stream?.toString('latin1') ?? '';
    if (!content.includes(' Tf')) continue;
    let font = '';
    for (const token of content.matchAll(/\/(F\d+) [\d.]+ Tf|<([0-9a-fA-F]*)>/g)) {
      if (token[1] != null) {
        font = token[1];
        continue;
      }
      const hex = token[2] ?? '';
      const cmap = toUnicode.get(font);
      if (cmap == null) {
        parts.push(Buffer.from(hex, 'hex').toString('latin1'));
      } else {
        for (let i = 0; i < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          const char = cmap.get(code) ?? '�';
          if (code === 0) missingGlyphs.push(char);
          parts.push(char);
        }
      }
    }
  }
  return {
    text: parts.join(''),
    fonts: [...new Set(baseFonts.values())].sort(),
    missingGlyphs,
  };
}

function detail(language: string): InvoiceDetail {
  const now = new Date('2026-06-04T12:00:00Z');
  return {
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
      currency: 'EUR',
      subtotalCents: 450,
      taxCents: 68,
      totalCents: 518,
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
        description: 'Segment 1 energy charge',
        quantity: '1',
        unitPriceCents: 300,
        totalCents: 300,
        taxCents: 57,
        taxRate: '0.19',
        metadata: { kind: 'energy', segment: 1 },
        createdAt: now,
      },
      {
        id: 2,
        invoiceId: 'inv_1',
        sessionId: 'ses_1',
        paymentRecordId: null,
        description: 'Segment 2 energy charge',
        quantity: '1',
        unitPriceCents: 150,
        totalCents: 150,
        taxCents: 11,
        taxRate: '0.07',
        metadata: { kind: 'energy', segment: 2 },
        createdAt: now,
      },
    ],
    driver: { id: 'drv_1', firstName: 'Jana', lastName: 'Weber', email: null, language },
    fleet: null,
    creditedInvoice: null,
    creditNote: null,
    taxBreakdown: [
      { taxRate: 0.07, netCents: 150, taxCents: 11, grossCents: 161 },
      { taxRate: 0.19, netCents: 300, taxCents: 57, grossCents: 357 },
    ],
  };
}

beforeEach(() => {
  warn.mockClear();
});

describe('resolveInvoicePdfLanguage', () => {
  it("uses the driver's language when the PDF fonts cover it", () => {
    expect(resolveInvoicePdfLanguage('de')).toBe('de');
    expect(resolveInvoicePdfLanguage('es')).toBe('es');
    expect(resolveInvoicePdfLanguage('ko')).toBe('ko');
    expect(resolveInvoicePdfLanguage('zh')).toBe('zh');
    expect(resolveInvoicePdfLanguage('zh-TW')).toBe('zh-TW');
  });

  it('falls back to English for unknown and missing languages', () => {
    expect(resolveInvoicePdfLanguage('fr')).toBe('en');
    expect(resolveInvoicePdfLanguage(null)).toBe('en');
    expect(resolveInvoicePdfLanguage(undefined)).toBe('en');
  });
});

describe('INVOICE_LABELS', () => {
  it('has every label in all six languages', () => {
    const keys = Object.keys(INVOICE_LABELS.en).sort();
    for (const lang of INVOICE_LANGUAGES) {
      expect(Object.keys(INVOICE_LABELS[lang]).sort()).toEqual(keys);
      for (const value of Object.values(INVOICE_LABELS[lang])) {
        expect(value).not.toBe('');
      }
    }
  });
});

describe('describeLineItem', () => {
  it('labels a fleet idle fee line with its minutes in every language', () => {
    const meta = { kind: 'idleFee', idleMinutes: 25 };
    expect(describeLineItem(INVOICE_LABELS.en, 'x', meta)).toBe('Idle fee, 25 min');
    expect(describeLineItem(INVOICE_LABELS.de, 'x', meta)).toBe('Standgebühr, 25 Min.');
    for (const lang of INVOICE_LANGUAGES) {
      expect(describeLineItem(INVOICE_LABELS[lang], 'x', meta)).toContain('25');
    }
  });

  it('localizes component lines with their segment', () => {
    expect(describeLineItem(INVOICE_LABELS.de, 'x', { kind: 'idleFee' })).toBe('Standgebühr');
    expect(describeLineItem(INVOICE_LABELS.de, 'x', { kind: 'energy', segment: 2 })).toBe(
      'Abschnitt 2: Energie',
    );
  });

  it('localizes session lines with date and energy', () => {
    expect(
      describeLineItem(INVOICE_LABELS.de, 'x', {
        kind: 'session',
        sessionDate: '2026-06-04',
        energyWh: 12345,
      }),
    ).toBe('Ladevorgang 04.06.2026 (12,35 kWh)');
  });

  it('keeps the stored description without a known kind', () => {
    expect(describeLineItem(INVOICE_LABELS.de, 'Charging session', null)).toBe('Charging session');
    expect(describeLineItem(INVOICE_LABELS.de, 'Legacy', { kind: 'other' })).toBe('Legacy');
  });
});

describe('generateInvoicePdf', () => {
  it('renders German labels with Helvetica, the tax rate per line, and the per-rate tax summary', async () => {
    const { text, fonts } = pdfContent(await generateInvoicePdf(detail('de')));
    expect(fonts).toEqual(['Helvetica', 'Helvetica-Bold']);
    expect(text).toContain('RECHNUNG');
    expect(text).toContain('STEUERAUFSTELLUNG');
    expect(text).toContain('Abschnitt 1: Energie');
    expect(text).toContain('19\u00a0%');
    expect(text).toContain('7\u00a0%');
    expect(text).toContain('Nettobetrag');
    expect(text).toContain('Gesamtbetrag');
    expect(text).toContain('Gesamtbetrag5,18 \u0080'); // pdfkit writes € as WinAnsi 0x80
  });

  it('renders a credit note with its title, the credited invoice, the reason and no due date', async () => {
    const base = detail('de');
    const credited = {
      id: 'inv_1',
      invoiceNumber: 'INV-202606-0042',
      issuedAt: new Date('2026-06-04T12:00:00Z'),
      paidAt: new Date('2026-06-05T12:00:00Z'),
    };
    const creditNote: InvoiceDetail = {
      ...base,
      invoice: {
        ...base.invoice,
        id: 'cn_1',
        invoiceNumber: 'CN-202606-0001',
        kind: 'credit_note',
        creditedInvoiceId: 'inv_1',
        creditReason: 'Falscher Tarif',
        dueAt: null,
        subtotalCents: -450,
        taxCents: -68,
        totalCents: -518,
      },
      lineItems: base.lineItems.map((line) => ({
        ...line,
        unitPriceCents: -line.unitPriceCents,
        totalCents: -line.totalCents,
        taxCents: -line.taxCents,
      })),
      taxBreakdown: base.taxBreakdown.map((line) => ({
        taxRate: line.taxRate,
        netCents: -line.netCents,
        taxCents: -line.taxCents,
        grossCents: -line.grossCents,
      })),
      creditedInvoice: credited,
    };

    const { text } = pdfContent(await generateInvoicePdf(creditNote));

    const labels = INVOICE_LABELS.de;
    expect(text).toContain(`Acme Charging${labels.creditNoteTitle}`);
    expect(text).toContain('CN-202606-0001');
    expect(text).toContain(`${labels.creditsInvoice}INV-202606-0042`);
    expect(text).toContain(`${labels.reason}Falscher Tarif`);
    expect(text).not.toContain(labels.due);
    expect(text).toContain(labels.creditNotePaidNote);
    expect(text).toContain('Gesamtbetrag-5,18');
  });

  it('names the credit note on a credited invoice', async () => {
    const base = detail('en');
    const credited: InvoiceDetail = {
      ...base,
      invoice: { ...base.invoice, status: 'credited' },
      creditNote: {
        id: 'cn_1',
        invoiceNumber: 'CN-202606-0001',
        issuedAt: new Date('2026-06-06T12:00:00Z'),
        paidAt: null,
      },
    };

    const { text } = pdfContent(await generateInvoicePdf(credited));

    expect(text).toContain('INVOICE');
    expect(text).toContain('StatusCredited');
    expect(text).toContain('Credit noteCN-202606-0001');
    expect(text).not.toContain(INVOICE_LABELS.en.creditNotePaidNote);
  });

  it.each([
    ['ko', 'kr'],
    ['zh', 'sc'],
    ['zh-TW', 'tc'],
  ] as const)(
    'renders %s labels with the regional Noto Sans CJK face',
    async (language, region) => {
      const labels = INVOICE_LABELS[language];
      const { text, fonts, missingGlyphs } = pdfContent(await generateInvoicePdf(detail(language)));

      // A character outside the fixture subset draws .notdef: regenerate the
      // subset fixtures to include the new label characters.
      expect(missingGlyphs).toEqual([]);
      expect(fonts).toHaveLength(2);
      expect(fonts[0]).toMatch(new RegExp(`^[A-Z]{6}\\+NotoSansCJK${region}-Bold$`));
      expect(fonts[1]).toMatch(new RegExp(`^[A-Z]{6}\\+NotoSansCJK${region}-Regular$`));
      expect(text).not.toContain('�');
      expect(text).not.toContain('INVOICE');
      for (const label of [
        labels.title,
        labels.billedTo,
        labels.statuses.issued,
        labels.taxSummary,
        labels.netAmount,
        labels.subtotal,
        labels.total,
        labels.amountsNote,
        describeLineItem(labels, 'x', { kind: 'energy', segment: 1 }),
        describeLineItem(labels, 'x', { kind: 'energy', segment: 2 }),
      ]) {
        expect(text).toContain(label);
      }
      expect(text).toContain('Jana Weber');
      expect(text).toContain('INV-202606-0042');
      expect(text).toContain('€5.18');
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe('generateInvoicePdf without the CJK fonts', () => {
  it('renders Korean and Chinese invoices in English and warns once', async () => {
    vi.resetModules();
    vi.doMock('@evtivity/services/pdf-fonts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@evtivity/services/pdf-fonts')>()),
      CJK_FONT_FILES: {
        regular: '/nonexistent/NotoSansCJK-Regular.ttc',
        bold: '/nonexistent/NotoSansCJK-Bold.ttc',
      },
    }));
    const service = await import('../invoice-pdf.service.js');

    // Latin languages never read the CJK fonts.
    const german = pdfContent(await service.generateInvoicePdf(detail('de')));
    expect(german.text).toContain('RECHNUNG');
    expect(warn).not.toHaveBeenCalled();

    expect(service.resolveInvoicePdfLanguage('ko')).toBe('en');
    for (const language of ['ko', 'zh', 'zh-TW']) {
      const { text, fonts } = pdfContent(await service.generateInvoicePdf(detail(language)));
      expect(fonts).toEqual(['Helvetica', 'Helvetica-Bold']);
      expect(text).toContain('INVOICE');
      expect(text).toContain('TAX SUMMARY');
      expect(text).toContain('Segment 2: Energy');
      expect(text).toContain('Total\u00805.18');
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.anything() as unknown }),
      'CJK fonts not found, Korean and Chinese PDFs render in English',
    );
    vi.doUnmock('@evtivity/services/pdf-fonts');
  });
});
