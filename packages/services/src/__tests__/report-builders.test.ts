// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

// Noto Sans CJK subsets (OFL) with the collection layout and PostScript names
// of the fonts-noto-cjk files, shared with the invoice PDF tests.
vi.mock('../pdf-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf-fonts.js')>()),
  CJK_FONT_FILES: {
    regular: fileURLToPath(
      new URL('./fixtures/noto-sans-cjk/NotoSansCJK-Regular-subset.ttc', import.meta.url),
    ),
    bold: fileURLToPath(
      new URL('./fixtures/noto-sans-cjk/NotoSansCJK-Bold-subset.ttc', import.meta.url),
    ),
  },
}));

import { buildXlsx } from '../report-generators/xlsx-builder.js';
import { PdfReportBuilder } from '../report-generators/pdf-builder.js';
import { dateCell, fixedCell, moneyCell, percentCell } from '../report-generators/report-cells.js';
import type { PdfBranding } from '../pdf-branding.js';

// A 1x1 PNG logo and no footer: pdf-branding.test.ts covers the branding.
const BRANDING: PdfBranding = {
  logo: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
  isDefaultLogo: false,
  footer: '',
};

/** BaseFont names and inflated content streams of a PDF, as latin1 text. */
function pdfParts(pdf: Buffer): { fonts: string[]; streams: string } {
  const raw = pdf.toString('latin1');
  const fonts = [...raw.matchAll(/\/BaseFont \/(\S+)/g)].map((m) =>
    (m[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
  );
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const data = Buffer.from(m[1] ?? '', 'latin1');
    try {
      streams.push(inflateSync(data).toString('latin1'));
    } catch {
      streams.push(data.toString('latin1'));
    }
  }
  return { fonts: [...new Set(fonts)].sort(), streams: streams.join('\n') };
}

const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex');

describe('buildXlsx', () => {
  it('writes localized sheet names and typed cells as numbers with a number format', async () => {
    const data = await buildXlsx([
      {
        name: '일별',
        headers: ['날짜', '에너지 (kWh)', '매출 (EUR)', '이용률 (%)'],
        rows: [
          [dateCell('2026-01-05'), fixedCell(12.3, 2), moneyCell(1250, 'EUR'), percentCell(4.5)],
        ],
      },
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(data).buffer);
    const sheet = workbook.getWorksheet('일별');
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      '날짜',
      '에너지 (kWh)',
      '매출 (EUR)',
      '이용률 (%)',
    ]);
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('2026-01-05');
    expect(row.getCell(2).value).toBe(12.3);
    expect(row.getCell(2).numFmt).toBe('#,##0.00');
    expect(row.getCell(3).value).toBe(12.5);
    expect(row.getCell(3).numFmt).toBe('#,##0.00');
    expect(row.getCell(4).value).toBe(4.5);
  });

  it('formats a zero-decimal fixed cell without a decimal point', async () => {
    const data = await buildXlsx([{ name: 'S', headers: ['n'], rows: [[fixedCell(3, 0)]] }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(data).buffer);
    expect(workbook.getWorksheet('S').getRow(2).getCell(1).numFmt).toBe('#,##0');
  });

  it('neutralises formula text, keeps raw numbers, and keeps empty separator rows', async () => {
    const data = await buildXlsx([
      {
        name: 'S',
        headers: ['label', 'count'],
        rows: [['=HYPERLINK("http://x")', 7], [], ['plain', null]],
      },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(data).buffer);
    const sheet = workbook.getWorksheet('S');

    const label = sheet.getRow(2).getCell(1).value;
    expect(typeof label).toBe('string');
    expect(label).not.toMatch(/^=/);
    expect(label).toContain('HYPERLINK');
    expect(sheet.getRow(2).getCell(2).value).toBe(7);
    expect(sheet.getRow(2).getCell(2).numFmt).toBeUndefined();
    // The empty row stays as a separator; the next data row follows it.
    expect(sheet.getRow(3).cellCount).toBe(0);
    expect(sheet.getRow(4).getCell(1).value).toBe('plain');
  });
});

describe('PdfReportBuilder', () => {
  it('uses Helvetica for Latin languages and writes subscript digits as plain digits', async () => {
    const pdf = await new PdfReportBuilder('de', BRANDING)
      .addTitle('Nachhaltigkeitsbericht')
      .addSummaryRow('Netto-THG-Reduktion:', '12,5 kg CO₂')
      .addTable(['THG-Reduktion (kg CO₂)'], [['1,00']])
      .build();

    const { fonts, streams } = pdfParts(pdf);
    expect(fonts).toEqual(['Helvetica', 'Helvetica-Bold']);
    expect(streams.toLowerCase()).toContain(hex('kg CO2'));
  });

  it('embeds the regional Noto Sans CJK faces for Korean and Chinese', async () => {
    const faces: Record<string, string[]> = {
      ko: ['NotoSansCJKkr-Bold', 'NotoSansCJKkr-Regular'],
      zh: ['NotoSansCJKsc-Bold', 'NotoSansCJKsc-Regular'],
      'zh-TW': ['NotoSansCJKtc-Bold', 'NotoSansCJKtc-Regular'],
    };
    for (const [language, expected] of Object.entries(faces)) {
      const pdf = await new PdfReportBuilder(language, BRANDING)
        .addTitle('Report')
        .addTable(['A'], [['1']])
        .build();
      expect(pdfParts(pdf).fonts).toEqual(expected);
    }
  });

  it('writes a subtitle and breaks a long table onto new pages', async () => {
    const pageCount = (pdf: Buffer): number =>
      [...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length;

    const short = await new PdfReportBuilder('en', BRANDING)
      .addTitle('Sessions')
      .addSubtitle('2026-01-01 to 2026-01-31')
      .addTable(['Station', 'kWh'], [['CS-1', '1.0']])
      .build();
    expect(pageCount(short)).toBe(1);
    expect(pdfParts(short).streams.toLowerCase()).toContain(hex('2026-01-01 to 2026-01-31'));

    const rows = Array.from({ length: 80 }, (_, i) => [`CS-${String(i)}`, String(i)]);
    const long = await new PdfReportBuilder('en', BRANDING)
      .addTitle('Sessions')
      .addSubtitle('All stations')
      .addTable(['Station', 'kWh'], rows)
      .build();
    // A4 landscape fits about 25 rows of 18 pt per page.
    expect(pageCount(long)).toBeGreaterThanOrEqual(3);
    expect(pdfParts(long).streams.toLowerCase()).toContain(hex('CS-79'));
  });
  /** Where the builder drew a text, and its wrapped height in the font it used. */
  function textCalls(spy: {
    mock: { calls: unknown[][] };
  }): Map<string, { y: number; width: number }> {
    const drawn = new Map<string, { y: number; width: number }>();
    for (const [label, , y, options] of spy.mock.calls) {
      drawn.set(String(label), {
        y: Number(y),
        width: (options as { width?: number } | undefined)?.width ?? 0,
      });
    }
    return drawn;
  }
  const measuring = new PDFDocument({ size: 'A4', layout: 'landscape' });
  const measure = (font: string, label: string, width: number): number =>
    measuring.fontSize(9).font(font).heightOfString(label, { width });

  it('sizes wrapped header and data rows to their tallest cell and draws the divider below them', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const moveTo = vi.spyOn(PDFDocument.prototype, 'moveTo');
    try {
      const headers = [
        'Date',
        'Billed on Account (unpaid) (incl. tax, EUR)',
        'Sessions without Electricity Cost (not in profit)',
      ];
      const longCell = 'A data cell long enough to wrap onto several lines in a narrow column';
      await new PdfReportBuilder('en', BRANDING)
        .addTitle('Revenue Report')
        .addTable(
          headers,
          [
            ['2026-01-01', longCell, '3'],
            ['2026-01-02', '1', '2'],
          ],
          [80, 90, 90],
        )
        .build();
      const drawn = textCalls(text);
      const at = (label: string): { y: number; width: number } => {
        const call = drawn.get(label);
        if (!call) throw new Error(`not drawn: ${label}`);
        return call;
      };

      const header = headers.map(at);
      const headerTop = header[0]?.y ?? 0;
      // Every header cell starts on the same line.
      expect(new Set(header.map((h) => h.y)).size).toBe(1);
      const headerBottom = Math.max(
        ...headers.map((h) => at(h).y + measure('Helvetica-Bold', h, at(h).width)),
      );
      // The long labels wrap onto more than one line.
      expect(headerBottom - headerTop).toBeGreaterThan(18);

      // The divider is drawn below the tallest header label, and the first row below it.
      const dividerY = Number(moveTo.mock.calls.at(-1)?.[1]);
      expect(dividerY).toBeGreaterThan(headerBottom);
      const row1 = at('2026-01-01').y;
      expect(row1).toBeGreaterThan(dividerY);

      // The wrapped data cell makes its row taller, and the next row starts below it.
      const longHeight = measure('Helvetica', longCell, at(longCell).width);
      expect(longHeight).toBeGreaterThan(18);
      expect(at(longCell).y).toBe(row1);
      expect(at('2026-01-02').y).toBeGreaterThanOrEqual(row1 + longHeight);
    } finally {
      text.mockRestore();
      moveTo.mockRestore();
    }
  });

  it('moves a wrapped row that does not fit to the next page whole', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    try {
      const tall = Array.from({ length: 6 }, (_, i) => `line ${String(i)} of a tall cell`).join(
        '\n',
      );
      const rows = Array.from({ length: 30 }, (_, i) => [`R-${String(i)}`, tall]);
      const pdf = await new PdfReportBuilder('en', BRANDING)
        .addTitle('Sessions')
        .addTable(['Station', 'Notes'], rows)
        .build();
      const drawn = textCalls(text);
      const tallCall = drawn.get(tall);
      const tallHeight = measure('Helvetica', tall, tallCall?.width ?? 0);
      // A4 landscape height minus the 50 pt bottom margin.
      const bottom = 595.28 - 50;
      const ys = text.mock.calls.filter((c) => c[0] === tall).map((c) => Number(c[2]));
      expect(ys).toHaveLength(30);
      for (const y of ys) expect(y + tallHeight).toBeLessThanOrEqual(bottom);
      for (const [label] of rows) {
        // The station cell is on the same line as its tall cell (the row did not split).
        expect(ys).toContain(drawn.get(String(label))?.y);
      }
      expect([...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length).toBeGreaterThan(1);
    } finally {
      text.mockRestore();
    }
  });
});
