// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import PDFDocument from 'pdfkit';
import { Resvg } from '@resvg/resvg-js';
import { client } from '@evtivity/database';
import { createLogger, formatCurrencyAmount, formatTaxRatePercent } from '@evtivity/lib';
import type { InvoiceDetail } from './invoice.service.js';
import { INVOICE_LABELS, describeLineItem, isInvoiceLanguage } from './invoice-labels.js';
import type { InvoiceLabels, InvoiceLanguage } from './invoice-labels.js';
import { pdfCanRender, registerPdfFonts } from './cjk-fonts.js';

const logger = createLogger('invoice-pdf');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 portrait width in points
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LOGO_MAX_WIDTH = 160;
const LOGO_MAX_HEIGHT = 60;
const PAGE_BOTTOM = 760;

const COLOR_TEXT = '#0f172a';
const COLOR_MUTED = '#64748b';
const COLOR_LINE = '#cbd5e1';

/**
 * The PDF language: the given language (the driver's, or the language stored
 * on a fleet invoice) when the PDF can render it, else English. Korean and Chinese need the Noto Sans CJK fonts of the API image
 * (`@evtivity/services/cjk-fonts`) and fall back to English without them.
 */
export function resolveInvoicePdfLanguage(
  driverLanguage: string | null | undefined,
): InvoiceLanguage {
  if (!isInvoiceLanguage(driverLanguage)) return 'en';
  if (!pdfCanRender(driverLanguage)) return 'en';
  return driverLanguage;
}

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

/** The fleet invoice bill-to block as stored on the invoice (FleetBillTo). */
interface BillToBlock {
  name: string;
  lines: string[];
  taxId: string | null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The bill-to snapshot of a fleet invoice, or null on a driver invoice. */
export function readBillTo(billTo: unknown): BillToBlock | null {
  if (billTo == null || typeof billTo !== 'object') return null;
  const record = billTo as Record<string, unknown>;
  const name = stringField(record, 'name');
  if (name == null) return null;
  const cityLine = [stringField(record, 'zip'), stringField(record, 'city')]
    .filter((part): part is string => part != null)
    .join(' ');
  const lines = [
    stringField(record, 'street'),
    cityLine !== '' ? cityLine : null,
    stringField(record, 'state'),
    stringField(record, 'country'),
  ].filter((line): line is string => line != null);
  return { name, lines, taxId: stringField(record, 'taxId') };
}

/** The billed month of a fleet invoice (period_start YYYY-MM-DD), e.g. "October 2026". */
export function formatPeriod(periodStart: string | null, locale: string): string | null {
  if (periodStart == null) return null;
  const parsed = new Date(`${periodStart.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return periodStart;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}

type LineItem = InvoiceDetail['lineItems'][number];

/** A driver's lines on a fleet invoice. */
export interface DriverLineGroup {
  driverId: string | null;
  driverName: string;
  items: LineItem[];
  /** Sum of the lines' net amounts. */
  netCents: number;
}

/**
 * The lines of a fleet invoice grouped by the driver in their metadata, in
 * the order the invoice lists them (the invoice is issued grouped by driver).
 */
export function groupLinesByDriver(lineItems: LineItem[]): DriverLineGroup[] {
  const groups: DriverLineGroup[] = [];
  const byKey = new Map<string, DriverLineGroup>();
  for (const item of lineItems) {
    const meta =
      item.metadata != null && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {};
    const driverId = typeof meta['driverId'] === 'string' ? meta['driverId'] : null;
    const driverName = typeof meta['driverName'] === 'string' ? meta['driverName'] : '';
    const key = driverId ?? '';
    let group = byKey.get(key);
    if (group == null) {
      group = { driverId, driverName, items: [], netCents: 0 };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
    group.netCents += item.totalCents;
  }
  return groups;
}

function formatDate(value: Date | string | null, locale: string): string {
  if (value == null) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** A table column: x offset from the margin, width, and alignment. */
interface Column {
  x: number;
  width: number;
  align: 'left' | 'right';
}

function drawRow(doc: PDFKit.PDFDocument, columns: Column[], values: string[], y: number): number {
  let height = 0;
  columns.forEach((col, i) => {
    const text = values[i] ?? '';
    doc.text(text, MARGIN + col.x, y, { width: col.width, align: col.align });
    height = Math.max(height, doc.heightOfString(text, { width: col.width }));
  });
  return Math.max(16, height + 4);
}

function drawRule(doc: PDFKit.PDFDocument, y: number, fromX = MARGIN): void {
  doc
    .moveTo(fromX, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .stroke(COLOR_LINE);
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed > PAGE_BOTTOM) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

export async function generateInvoicePdf(detail: InvoiceDetail): Promise<Buffer> {
  const { invoice, lineItems, driver, taxBreakdown, creditedInvoice, creditNote } = detail;
  const isCreditNote = invoice.kind === 'credit_note';
  const isFleetInvoice = invoice.fleetId != null;
  const language = resolveInvoicePdfLanguage(invoice.language ?? driver?.language);
  const labels: InvoiceLabels = INVOICE_LABELS[language];
  const money = (cents: number): string =>
    formatCurrencyAmount(cents, invoice.currency, labels.locale);
  const rate = (taxRate: number | string): string =>
    labels.taxRateValue.replace('{rate}', formatTaxRatePercent(Number(taxRate), labels.locale));

  const branding = await getCompanyBranding();
  const logoBuffer = decodeLogo(branding.logo);

  const doc = new PDFDocument({ margin: MARGIN, size: 'A4', layout: 'portrait' });
  const fonts = registerPdfFonts(doc, language);
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
      doc.fontSize(22).font(fonts.bold).fillColor(COLOR_TEXT).text(branding.name, MARGIN, MARGIN);
      headerBottom = MARGIN + 30;
    }
  } else {
    doc.fontSize(22).font(fonts.bold).fillColor(COLOR_TEXT).text(branding.name, MARGIN, MARGIN);
    headerBottom = MARGIN + 30;
  }

  doc
    .fontSize(20)
    .font(fonts.bold)
    .fillColor(COLOR_TEXT)
    .text(isCreditNote ? labels.creditNoteTitle : labels.title, MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: 'right',
    });
  doc
    .fontSize(11)
    .font(fonts.regular)
    .fillColor(COLOR_MUTED)
    .text(invoice.invoiceNumber, MARGIN, MARGIN + 26, { width: CONTENT_WIDTH, align: 'right' });

  let y = Math.max(headerBottom, MARGIN + 50) + 20;
  drawRule(doc, y);
  y += 20;

  // Meta block: billed-to driver (or the fleet's bill-to block) and the issuing company.
  const rightX = MARGIN + CONTENT_WIDTH / 2;
  const billTo = readBillTo(invoice.billTo);
  const billedToName =
    billTo?.name ?? (driver != null ? `${driver.firstName} ${driver.lastName}`.trim() : '—');
  const billedToDetails =
    billTo != null
      ? [
          ...billTo.lines,
          ...(billTo.taxId != null ? [labels.taxId.replace('{id}', billTo.taxId)] : []),
        ]
      : driver?.email != null && driver.email !== ''
        ? [driver.email]
        : [];

  doc.fontSize(9).font(fonts.bold).fillColor(COLOR_MUTED).text(labels.billedTo, MARGIN, y);
  doc
    .fontSize(11)
    .font(fonts.regular)
    .fillColor(COLOR_TEXT)
    .text(billedToName, MARGIN, y + 12, { width: CONTENT_WIDTH / 2 - 10 });
  let detailY = y + 27;
  for (const detailLine of billedToDetails) {
    doc
      .fontSize(10)
      .fillColor(COLOR_MUTED)
      .text(detailLine, MARGIN, detailY, { width: CONTENT_WIDTH / 2 - 10 });
    detailY += 14;
  }

  doc.fontSize(9).font(fonts.bold).fillColor(COLOR_MUTED).text(labels.from, rightX, y);
  doc
    .fontSize(11)
    .font(fonts.regular)
    .fillColor(COLOR_TEXT)
    .text(branding.name, rightX, y + 12);

  y = Math.max(y + 50, detailY + 10);

  const metaRows: Array<[string, string]> = [
    [labels.status, labels.statuses[invoice.status]],
    [labels.issued, formatDate(invoice.issuedAt, labels.locale)],
  ];
  const period = formatPeriod(invoice.periodStart, labels.locale);
  if (period != null) metaRows.push([labels.period, period]);
  // A credit note has no due date; it names the invoice it credits and why.
  if (isCreditNote) {
    metaRows.push([labels.creditsInvoice, creditedInvoice?.invoiceNumber ?? '—']);
    if (invoice.creditReason != null) metaRows.push([labels.reason, invoice.creditReason]);
  } else {
    metaRows.push([labels.due, formatDate(invoice.dueAt, labels.locale)]);
  }
  if (creditNote != null) metaRows.push([labels.creditedBy, creditNote.invoiceNumber]);
  for (const [label, value] of metaRows) {
    doc.fontSize(10).font(fonts.regular).fillColor(COLOR_MUTED).text(label, MARGIN, y, {
      width: 120,
    });
    doc
      .fontSize(10)
      .font(fonts.bold)
      .fillColor(COLOR_TEXT)
      .text(value, MARGIN + 120, y, { width: CONTENT_WIDTH - 120 });
    y += Math.max(16, doc.heightOfString(value, { width: CONTENT_WIDTH - 120 }) + 4);
  }

  y += 14;

  // Line items: description, quantity, net unit price, tax rate, net amount.
  const itemColumns: Column[] = [
    { x: 0, width: 205, align: 'left' },
    { x: 210, width: 35, align: 'right' },
    { x: 250, width: 80, align: 'right' },
    { x: 335, width: 60, align: 'right' },
    { x: 400, width: CONTENT_WIDTH - 400, align: 'right' },
  ];
  doc.fontSize(9).font(fonts.bold).fillColor(COLOR_MUTED);
  y += drawRow(
    doc,
    itemColumns,
    [labels.description, labels.quantity, labels.unitPrice, labels.taxRate, labels.amount],
    y,
  );
  drawRule(doc, y - 4);

  const drawItem = (item: LineItem): void => {
    y = ensureSpace(doc, y, 30);
    const qty = Number(item.quantity);
    doc.font(fonts.regular).fontSize(10).fillColor(COLOR_TEXT);
    y += drawRow(
      doc,
      itemColumns,
      [
        describeLineItem(labels, item.description, item.metadata),
        Number.isNaN(qty) ? item.quantity : qty.toString(),
        money(item.unitPriceCents),
        rate(item.taxRate),
        money(item.totalCents),
      ],
      y,
    );
  };

  if (isFleetInvoice) {
    // A fleet invoice lists each driver's sessions under the driver, with a
    // net subtotal per driver; the tax summary below covers the whole invoice.
    for (const group of groupLinesByDriver(lineItems)) {
      y = ensureSpace(doc, y, 50);
      const name = group.driverName !== '' ? group.driverName : labels.unknownDriver;
      doc.font(fonts.bold).fontSize(10).fillColor(COLOR_TEXT).text(name, MARGIN, y, {
        width: CONTENT_WIDTH,
      });
      y += 16;
      for (const item of group.items) drawItem(item);
      y = ensureSpace(doc, y, 20);
      drawRule(doc, y - 2, MARGIN + CONTENT_WIDTH / 2);
      doc.font(fonts.bold).fontSize(10).fillColor(COLOR_TEXT);
      y += drawRow(
        doc,
        itemColumns,
        [labels.driverSubtotal.replace('{driver}', name), '', '', '', money(group.netCents)],
        y,
      );
      y += 6;
    }
  } else {
    for (const item of lineItems) drawItem(item);
  }

  y += 10;

  // Tax summary: net amount, tax rate, and tax amount per rate. Must not
  // split across pages.
  const summaryColumns: Column[] = [
    { x: 0, width: 120, align: 'left' },
    { x: 125, width: 120, align: 'right' },
    { x: 250, width: 120, align: 'right' },
    { x: 375, width: CONTENT_WIDTH - 375, align: 'right' },
  ];
  y = ensureSpace(doc, y, 30 + taxBreakdown.length * 16);
  doc.fontSize(9).font(fonts.bold).fillColor(COLOR_MUTED).text(labels.taxSummary, MARGIN, y);
  y += 16;
  y += drawRow(
    doc,
    summaryColumns,
    [labels.taxRate, labels.netAmount, labels.tax, labels.grossAmount],
    y,
  );
  drawRule(doc, y - 4);
  doc.font(fonts.regular).fontSize(10).fillColor(COLOR_TEXT);
  for (const line of taxBreakdown) {
    y += drawRow(
      doc,
      summaryColumns,
      [rate(line.taxRate), money(line.netCents), money(line.taxCents), money(line.grossCents)],
      y,
    );
  }

  y += 10;

  // Totals block (divider + net subtotal + tax + total) must not split across pages.
  y = ensureSpace(doc, y, 10 + 16 + 16 + 20 + 20);
  drawRule(doc, y, MARGIN + CONTENT_WIDTH / 2);
  y += 10;

  const totalsX = MARGIN + CONTENT_WIDTH / 2;
  const amountCol = itemColumns[4] ?? { x: 400, width: CONTENT_WIDTH - 400, align: 'right' };
  const totalsLabelWidth = CONTENT_WIDTH / 2 - amountCol.width;
  const totalRows: Array<[string, string, boolean]> = [
    [labels.subtotal, money(invoice.subtotalCents), false],
    [labels.totalTax, money(invoice.taxCents), false],
    [labels.total, money(invoice.totalCents), true],
  ];
  for (const [label, value, bold] of totalRows) {
    doc
      .fontSize(bold ? 12 : 10)
      .font(bold ? fonts.bold : fonts.regular)
      .fillColor(bold ? COLOR_TEXT : COLOR_MUTED)
      .text(label, totalsX, y, { width: totalsLabelWidth });
    doc
      .fontSize(bold ? 12 : 10)
      .font(bold ? fonts.bold : fonts.regular)
      .fillColor(COLOR_TEXT)
      .text(value, MARGIN + amountCol.x, y, { width: amountCol.width, align: 'right' });
    y += bold ? 20 : 16;
  }

  doc
    .fontSize(8)
    .font(fonts.regular)
    .fillColor(COLOR_MUTED)
    .text(labels.amountsNote, MARGIN, y + 4, { width: CONTENT_WIDTH });
  if (isCreditNote && creditedInvoice?.paidAt != null) {
    const noteY = ensureSpace(doc, y + 16, 24);
    doc.text(labels.creditNotePaidNote, MARGIN, noteY, { width: CONTENT_WIDTH });
  }

  doc.end();
  return built;
}
