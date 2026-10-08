// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

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
    const pdf = await new PdfReportBuilder('de')
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
      const pdf = await new PdfReportBuilder(language)
        .addTitle('Report')
        .addTable(['A'], [['1']])
        .build();
      expect(pdfParts(pdf).fonts).toEqual(expected);
    }
  });

  it('writes a subtitle and breaks a long table onto new pages', async () => {
    const pageCount = (pdf: Buffer): number =>
      [...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length;

    const short = await new PdfReportBuilder('en')
      .addTitle('Sessions')
      .addSubtitle('2026-01-01 to 2026-01-31')
      .addTable(['Station', 'kWh'], [['CS-1', '1.0']])
      .build();
    expect(pageCount(short)).toBe(1);
    expect(pdfParts(short).streams.toLowerCase()).toContain(hex('2026-01-01 to 2026-01-31'));

    const rows = Array.from({ length: 80 }, (_, i) => [`CS-${String(i)}`, String(i)]);
    const long = await new PdfReportBuilder('en')
      .addTitle('Sessions')
      .addSubtitle('All stations')
      .addTable(['Station', 'kWh'], rows)
      .build();
    // A4 landscape fits about 25 rows of 18 pt per page.
    expect(pageCount(long)).toBeGreaterThanOrEqual(3);
    expect(pdfParts(long).streams.toLowerCase()).toContain(hex('CS-79'));
  });
});
