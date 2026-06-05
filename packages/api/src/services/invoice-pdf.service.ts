// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import PDFDocument from 'pdfkit';
import { Resvg } from '@resvg/resvg-js';
import { client } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { InvoiceDetail } from './invoice.service.js';

const logger = createLogger('invoice-pdf');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 portrait width in points
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LOGO_MAX_WIDTH = 160;
const LOGO_MAX_HEIGHT = 60;

const COLOR_TEXT = '#0f172a';
const COLOR_MUTED = '#64748b';
const COLOR_LINE = '#cbd5e1';

interface CompanyBranding {
  name: string;
  logo: string | null;
}

async function getCompanyBranding(): Promise<CompanyBranding> {
  const rows = await client`
    SELECT key, value FROM settings WHERE key IN ('company.name', 'company.logo')
  `;
  let name = 'EVtivity';
  let logo: string | null = null;
  for (const row of rows) {
    const key = (row as { key: string }).key;
    const value: unknown = (row as { value: unknown }).value;
    if (key === 'company.name' && typeof value === 'string' && value !== '') {
      name = value;
    } else if (key === 'company.logo' && typeof value === 'string' && value !== '') {
      logo = value;
    }
  }
  return { name, logo };
}

/**
 * Decode a data URI logo into a PNG/JPEG buffer pdfkit can embed. SVG logos are
 * rasterized via resvg. Returns null when the logo is absent, not a data URI,
 * an unsupported format, or rasterization fails -- the caller falls back to a
 * text wordmark so a bad logo never breaks the PDF.
 */
function decodeLogo(logo: string | null): Buffer | null {
  if (logo == null) return null;
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(logo);
  if (match == null) return null;
  const mime = match[1] ?? '';
  const isBase64 = match[2] != null;
  const payload = match[3] ?? '';

  try {
    if (mime === 'image/svg+xml') {
      const svg = isBase64
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: LOGO_MAX_WIDTH * 2 } });
      return Buffer.from(resvg.render().asPng());
    }
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg') {
      if (!isBase64) return null;
      return Buffer.from(payload, 'base64');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to decode invoice logo, falling back to wordmark');
    return null;
  }
  return null;
}

function formatAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value: Date | string | null): string {
  if (value == null) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export async function generateInvoicePdf(detail: InvoiceDetail): Promise<Buffer> {
  const { invoice, lineItems, driver } = detail;
  const branding = await getCompanyBranding();
  const logoBuffer = decodeLogo(branding.logo);

  const doc = new PDFDocument({ margin: MARGIN, size: 'A4', layout: 'portrait' });
  const chunks: Buffer[] = [];

  const built = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  // Header: logo (or wordmark) on the left, invoice meta on the right.
  let headerBottom = MARGIN;
  if (logoBuffer != null) {
    try {
      doc.image(logoBuffer, MARGIN, MARGIN, {
        fit: [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT],
      });
      headerBottom = MARGIN + LOGO_MAX_HEIGHT;
    } catch (err) {
      logger.warn({ err }, 'pdfkit rejected invoice logo, falling back to wordmark');
      doc
        .fontSize(22)
        .font('Helvetica-Bold')
        .fillColor(COLOR_TEXT)
        .text(branding.name, MARGIN, MARGIN);
      headerBottom = MARGIN + 30;
    }
  } else {
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor(COLOR_TEXT)
      .text(branding.name, MARGIN, MARGIN);
    headerBottom = MARGIN + 30;
  }

  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .fillColor(COLOR_TEXT)
    .text('INVOICE', MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' });
  doc
    .fontSize(11)
    .font('Helvetica')
    .fillColor(COLOR_MUTED)
    .text(invoice.invoiceNumber, MARGIN, MARGIN + 26, { width: CONTENT_WIDTH, align: 'right' });

  let y = Math.max(headerBottom, MARGIN + 50) + 20;

  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .stroke(COLOR_LINE);
  y += 20;

  // Meta block: company name + invoice details.
  const rightX = MARGIN + CONTENT_WIDTH / 2;
  const billedToName = driver != null ? `${driver.firstName} ${driver.lastName}`.trim() : '—';
  const billedToEmail = driver?.email ?? '';

  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR_MUTED).text('BILLED TO', MARGIN, y);
  doc
    .fontSize(11)
    .font('Helvetica')
    .fillColor(COLOR_TEXT)
    .text(billedToName, MARGIN, y + 12);
  if (billedToEmail !== '') {
    doc
      .fontSize(10)
      .fillColor(COLOR_MUTED)
      .text(billedToEmail, MARGIN, y + 27);
  }

  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR_MUTED).text('FROM', rightX, y);
  doc
    .fontSize(11)
    .font('Helvetica')
    .fillColor(COLOR_TEXT)
    .text(branding.name, rightX, y + 12);

  y += 50;

  const metaRows: Array<[string, string]> = [
    ['Status', invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)],
    ['Issued', formatDate(invoice.issuedAt)],
    ['Due', formatDate(invoice.dueAt)],
  ];
  for (const [label, value] of metaRows) {
    doc.fontSize(10).font('Helvetica').fillColor(COLOR_MUTED).text(label, MARGIN, y, {
      width: 120,
    });
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(COLOR_TEXT)
      .text(value, MARGIN + 120, y);
    y += 16;
  }

  y += 14;

  // Line items table.
  const cols = {
    description: MARGIN,
    qty: MARGIN + 300,
    unit: MARGIN + 350,
    total: MARGIN + 430,
  };
  const colWidths = {
    description: 290,
    qty: 40,
    unit: 75,
    total: CONTENT_WIDTH - 430,
  };

  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR_MUTED);
  doc.text('DESCRIPTION', cols.description, y, { width: colWidths.description });
  doc.text('QTY', cols.qty, y, { width: colWidths.qty, align: 'right' });
  doc.text('UNIT', cols.unit, y, { width: colWidths.unit, align: 'right' });
  doc.text('TOTAL', cols.total, y, { width: colWidths.total, align: 'right' });
  y += 16;
  doc
    .moveTo(MARGIN, y - 4)
    .lineTo(MARGIN + CONTENT_WIDTH, y - 4)
    .stroke(COLOR_LINE);

  doc.font('Helvetica').fontSize(10).fillColor(COLOR_TEXT);
  for (const item of lineItems) {
    if (y > 720) {
      doc.addPage();
      y = MARGIN;
    }
    const qty = Number(item.quantity);
    doc.text(item.description, cols.description, y, { width: colWidths.description });
    doc.text(Number.isNaN(qty) ? item.quantity : qty.toString(), cols.qty, y, {
      width: colWidths.qty,
      align: 'right',
    });
    doc.text(formatAmount(item.unitPriceCents, invoice.currency), cols.unit, y, {
      width: colWidths.unit,
      align: 'right',
    });
    doc.text(formatAmount(item.totalCents, invoice.currency), cols.total, y, {
      width: colWidths.total,
      align: 'right',
    });
    const descHeight = doc.heightOfString(item.description, { width: colWidths.description });
    y += Math.max(16, descHeight + 4);
  }

  y += 6;

  // Totals block (divider + subtotal + tax + total) must not split across pages.
  const TOTALS_BLOCK_HEIGHT = 10 + 16 + 16 + 20;
  if (y + TOTALS_BLOCK_HEIGHT > 760) {
    doc.addPage();
    y = MARGIN;
  }

  doc
    .moveTo(MARGIN + CONTENT_WIDTH / 2, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .stroke(COLOR_LINE);
  y += 10;

  const totalsX = MARGIN + CONTENT_WIDTH / 2;
  const totalsLabelWidth = CONTENT_WIDTH / 2 - colWidths.total;
  const totalRows: Array<[string, string, boolean]> = [
    ['Subtotal', formatAmount(invoice.subtotalCents, invoice.currency), false],
    ['Tax', formatAmount(invoice.taxCents, invoice.currency), false],
    ['Total', formatAmount(invoice.totalCents, invoice.currency), true],
  ];
  for (const [label, value, bold] of totalRows) {
    doc
      .fontSize(bold ? 12 : 10)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(bold ? COLOR_TEXT : COLOR_MUTED)
      .text(label, totalsX, y, { width: totalsLabelWidth });
    doc
      .fontSize(bold ? 12 : 10)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(COLOR_TEXT)
      .text(value, cols.total, y, { width: colWidths.total, align: 'right' });
    y += bold ? 20 : 16;
  }

  doc.end();
  return built;
}
