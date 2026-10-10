// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import PDFDocument from 'pdfkit';
import { LATIN_FONTS, registerPdfFonts, type PdfFonts } from '../cjk-fonts.js';
import { createLogger } from '@evtivity/lib';
import {
  defaultPdfLogoPng,
  drawPdfFooter,
  layoutPdfFooter,
  reservePdfFooterSpace,
  type PdfBranding,
  type PdfFooterLayout,
} from '../pdf-branding.js';

const logger = createLogger('pdf-report');

const FONT_SIZE_TITLE = 20;
const FONT_SIZE_SUBTITLE = 14;
const FONT_SIZE_TABLE = 9;
const FONT_SIZE_SUMMARY = 11;
const MARGIN = 50;
const ROW_HEIGHT = 18;
// Space under the tallest cell of a row; the header divider sits in its middle.
const ROW_PADDING = 8;
// Space between the text of two neighboring columns.
const CELL_GAP = 6;
const DEFAULT_COLUMN_WIDTH = 100;
const LOGO_MAX_WIDTH = 140;
const LOGO_MAX_HEIGHT = 36;
const LOGO_GAP = 14;

// The standard PDF fonts only cover WinAnsi, which has no subscript digits.
const SUBSCRIPT_DIGITS = /[\u2080-\u2089]/g;

function cellTextWidth(columnWidth: number | undefined): number {
  return Math.max(1, (columnWidth ?? DEFAULT_COLUMN_WIDTH) - CELL_GAP);
}

/** Text of a table cell; report generators pass formatted strings and plain numbers. */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export class PdfReportBuilder {
  private readonly doc: InstanceType<typeof PDFDocument>;
  private readonly fonts: PdfFonts;
  private readonly footer: PdfFooterLayout;
  private readonly bottomMargin: number;
  private y: number;

  /**
   * `language` picks the fonts: Korean and Chinese use the Noto Sans CJK fonts
   * (resolve it with reportLocale, which falls back to English without them).
   * `branding` (loadPdfBranding) gives the logo drawn at the top of the first
   * page and the footer drawn at the bottom of every page.
   */
  constructor(language: string, branding: PdfBranding) {
    this.doc = new PDFDocument({
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN },
      size: 'A4',
      layout: 'landscape',
      bufferPages: true,
    });
    this.fonts = registerPdfFonts(this.doc, language);
    this.footer = layoutPdfFooter(this.doc, branding.footer, this.contentWidth());
    this.bottomMargin = reservePdfFooterSpace(this.doc, this.footer, MARGIN);
    try {
      this.doc.image(branding.logo, MARGIN, MARGIN, { fit: [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT] });
    } catch (err) {
      logger.warn({ err }, 'pdfkit rejected the PDF logo, using the default logo');
      this.doc.image(defaultPdfLogoPng(), MARGIN, MARGIN, {
        fit: [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT],
      });
    }
    this.doc.font(this.fonts.regular).fillColor('#000000');
    this.y = MARGIN + LOGO_MAX_HEIGHT + LOGO_GAP;
  }

  private contentWidth(): number {
    return this.doc.page.width - MARGIN * 2;
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
    const headerCells = headers.map((h) => this.printable(h));
    const rowCells = rows.map((row) =>
      Array.from({ length: colCount }, (_, i) => this.printable(cellText(row[i]))),
    );

    // Header row: as tall as its tallest wrapped label, kept on the page with the first data row.
    this.doc.fontSize(FONT_SIZE_TABLE).font(this.fonts.bold);
    const headerHeight = this.rowHeight(headerCells, widths);
    this.doc.font(this.fonts.regular);
    const firstRowHeight = rowCells[0] ? this.rowHeight(rowCells[0], widths) : 0;
    this.checkPageBreak(headerHeight + firstRowHeight);

    this.doc.font(this.fonts.bold);
    this.drawRow(headerCells, widths);
    this.y += headerHeight;

    // Separator line, below the tallest header label and above the first data row.
    this.doc
      .moveTo(MARGIN, this.y - ROW_PADDING / 2)
      .lineTo(MARGIN + pageWidth, this.y - ROW_PADDING / 2)
      .stroke('#cccccc');

    // Data rows: each as tall as its tallest wrapped cell, never split across pages.
    this.doc.font(this.fonts.regular).fontSize(FONT_SIZE_TABLE);
    for (const cells of rowCells) {
      const height = this.rowHeight(cells, widths);
      this.checkPageBreak(height);
      this.drawRow(cells, widths);
      this.y += height;
    }

    this.y += 10;
    return this;
  }

  /** Height of a table row in the current font: its tallest wrapped cell plus padding. */
  private rowHeight(cells: string[], widths: number[]): number {
    let text = 0;
    cells.forEach((cell, i) => {
      text = Math.max(text, this.doc.heightOfString(cell, { width: cellTextWidth(widths[i]) }));
    });
    return Math.max(ROW_HEIGHT, Math.ceil(text) + ROW_PADDING);
  }

  private drawRow(cells: string[], widths: number[]): void {
    let x = MARGIN;
    cells.forEach((cell, i) => {
      this.doc.text(cell, x, this.y, { width: cellTextWidth(widths[i]) });
      x += widths[i] ?? DEFAULT_COLUMN_WIDTH;
    });
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
      drawPdfFooter(this.doc, this.footer, MARGIN, this.contentWidth());
      this.doc.end();
    });
  }

  private checkPageBreak(needed: number): void {
    if (this.y + needed > this.doc.page.height - this.bottomMargin) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }
}
