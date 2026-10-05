// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import PDFDocument from 'pdfkit';
import { LATIN_FONTS, registerPdfFonts, type PdfFonts } from '../cjk-fonts.js';

const FONT_SIZE_TITLE = 20;
const FONT_SIZE_SUBTITLE = 14;
const FONT_SIZE_TABLE = 9;
const FONT_SIZE_SUMMARY = 11;
const MARGIN = 50;
const ROW_HEIGHT = 18;

// The standard PDF fonts only cover WinAnsi, which has no subscript digits.
const SUBSCRIPT_DIGITS = /[\u2080-\u2089]/g;

export class PdfReportBuilder {
  private readonly doc: InstanceType<typeof PDFDocument>;
  private readonly fonts: PdfFonts;
  private y: number;

  /**
   * `language` picks the fonts: Korean and Chinese use the Noto Sans CJK fonts
   * (resolve it with reportLocale, which falls back to English without them).
   */
  constructor(language: string) {
    this.doc = new PDFDocument({ margin: MARGIN, size: 'A4', layout: 'landscape' });
    this.fonts = registerPdfFonts(this.doc, language);
    this.y = MARGIN;
  }

  /** Text the selected font can draw: "CO₂" becomes "CO2" in Helvetica. */
  private printable(text: string): string {
    if (this.fonts !== LATIN_FONTS) return text;
    return text.replace(SUBSCRIPT_DIGITS, (d) => String(d.charCodeAt(0) - 0x2080));
  }

  addTitle(text: string): this {
    this.doc
      .fontSize(FONT_SIZE_TITLE)
      .font(this.fonts.bold)
      .text(this.printable(text), MARGIN, this.y);
    this.y += FONT_SIZE_TITLE + 10;
    return this;
  }

  addSubtitle(text: string): this {
    this.doc
      .fontSize(FONT_SIZE_SUBTITLE)
      .font(this.fonts.regular)
      .fillColor('#555555')
      .text(this.printable(text), MARGIN, this.y);
    this.y += FONT_SIZE_SUBTITLE + 8;
    this.doc.fillColor('#000000');
    return this;
  }

  addTable(headers: string[], rows: unknown[][], columnWidths?: number[]): this {
    const pageWidth = this.doc.page.width - MARGIN * 2;
    const colCount = headers.length;
    const widths = columnWidths ?? headers.map(() => Math.floor(pageWidth / colCount));

    this.checkPageBreak(ROW_HEIGHT * 2);

    // Header row
    this.doc.fontSize(FONT_SIZE_TABLE).font(this.fonts.bold);
    let x = MARGIN;
    for (let i = 0; i < colCount; i++) {
      const w = widths[i] ?? 100;
      this.doc.text(this.printable(headers[i] ?? ''), x, this.y, { width: w, ellipsis: true });
      x += w;
    }
    this.y += ROW_HEIGHT;

    // Separator line
    this.doc
      .moveTo(MARGIN, this.y - 4)
      .lineTo(MARGIN + pageWidth, this.y - 4)
      .stroke('#cccccc');

    // Data rows
    this.doc.font(this.fonts.regular).fontSize(FONT_SIZE_TABLE);
    for (const row of rows) {
      this.checkPageBreak(ROW_HEIGHT);
      x = MARGIN;
      for (let i = 0; i < colCount; i++) {
        const w = widths[i] ?? 100;
        const val = row[i] != null ? String(row[i]) : '';
        this.doc.text(this.printable(val), x, this.y, { width: w, ellipsis: true });
        x += w;
      }
      this.y += ROW_HEIGHT;
    }

    this.y += 10;
    return this;
  }

  addSummaryRow(label: string, value: string): this {
    this.checkPageBreak(ROW_HEIGHT);
    this.doc
      .fontSize(FONT_SIZE_SUMMARY)
      .font(this.fonts.bold)
      .text(this.printable(label), MARGIN, this.y, { continued: true });
    this.doc.font(this.fonts.regular).text(`  ${this.printable(value)}`);
    this.y += ROW_HEIGHT + 2;
    return this;
  }

  async build(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.doc.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      this.doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      this.doc.on('error', reject);
      this.doc.end();
    });
  }

  private checkPageBreak(needed: number): void {
    if (this.y + needed > this.doc.page.height - MARGIN) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }
}
