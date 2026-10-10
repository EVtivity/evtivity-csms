// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import PDFDocument from 'pdfkit';
import { client } from '@evtivity/database';
import {
  COMPANY_INVOICE_EMAIL_KEY,
  COMPANY_INVOICE_PHONE_KEY,
  COMPANY_REGISTRATION_NUMBER_KEY,
  COMPANY_TAX_ID_KEY,
  COMPANY_TAX_ID_LABEL_KEY,
  INVOICE_SELLER_SETTING_KEYS,
  createLogger,
  formatCurrencyAmount,
  formatTaxRatePercent,
} from '@evtivity/lib';
import type { InvoiceDetail } from './invoice.service.js';
import { INVOICE_LABELS, describeLineItem, isInvoiceLanguage } from './invoice-labels.js';
import type { InvoiceLabels, InvoiceLanguage } from './invoice-labels.js';
import { pdfCanRender, registerPdfFonts, registerPdfTextFonts } from './cjk-fonts.js';
import {
  defaultPdfLogoPng,
  drawPdfFooter,
  layoutPdfFooter,
  loadPdfBranding,
  reservePdfFooterSpace,
} from './pdf-branding.js';

const logger = createLogger('invoice-pdf');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 portrait width in points
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LOGO_MAX_WIDTH = 160;
const LOGO_MAX_HEIGHT = 60;
/** Lowest y of the page content with the default bottom margin. */
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
  return { name, lines: addressLines(record), taxId: stringField(record, 'taxId') };
}

/**
 * Address lines from `street`, `zip`, `city`, `state` and `country` fields:
 * the street, "zip city", the state and the country, each left out when empty.
 */
function addressLines(record: Record<string, unknown>): string[] {
  const cityLine = [stringField(record, 'zip'), stringField(record, 'city')]
    .filter((part): part is string => part != null)
    .join(' ');
  return [
    stringField(record, 'street'),
    cityLine !== '' ? cityLine : null,
    stringField(record, 'state'),
    stringField(record, 'country'),
  ].filter((line): line is string => line != null);
}

/** The seller printed in the "From" block of an invoice or credit note. */
export interface InvoiceSeller {
  name: string;
  /** The company address, formatted like the fleet bill-to block. */
  addressLines: string[];
  taxId: string | null;
  /** The operator's tax ID label; null prints the localized "Tax ID" label. */
  taxIdLabel: string | null;
  registrationNumber: string | null;
  email: string | null;
  phone: string | null;
}

const COMPANY_ADDRESS_KEYS = {
  street: 'company.street',
  city: 'company.city',
  zip: 'company.zip',
  state: 'company.state',
  country: 'company.country',
} as const;

const SELLER_SETTING_KEYS = [
  'company.name',
  ...Object.values(COMPANY_ADDRESS_KEYS),
  ...INVOICE_SELLER_SETTING_KEYS,
];

/** The seller from the settings rows (key to value). Empty values are null. */
export function readInvoiceSeller(settings: Record<string, unknown>): InvoiceSeller {
  return {
    name: stringField(settings, 'company.name') ?? 'EVtivity',
    addressLines: addressLines({
      street: settings[COMPANY_ADDRESS_KEYS.street],
      city: settings[COMPANY_ADDRESS_KEYS.city],
      zip: settings[COMPANY_ADDRESS_KEYS.zip],
      state: settings[COMPANY_ADDRESS_KEYS.state],
      country: settings[COMPANY_ADDRESS_KEYS.country],
    }),
    taxId: stringField(settings, COMPANY_TAX_ID_KEY),
    taxIdLabel: stringField(settings, COMPANY_TAX_ID_LABEL_KEY),
    registrationNumber: stringField(settings, COMPANY_REGISTRATION_NUMBER_KEY),
    email: stringField(settings, COMPANY_INVOICE_EMAIL_KEY),
    phone: stringField(settings, COMPANY_INVOICE_PHONE_KEY),
  };
}

/**
 * The lines printed under the seller's name: the address, the tax ID with
 * its label, the registration number, the invoice email and phone. Fields
 * that are not set are left out.
 */
export function sellerDetailLines(seller: InvoiceSeller, labels: InvoiceLabels): string[] {
  const lines = [...seller.addressLines];
  if (seller.taxId != null) {
    lines.push(
      seller.taxIdLabel != null
        ? `${seller.taxIdLabel}: ${seller.taxId}`
        : labels.sellerTaxId.replace('{id}', seller.taxId),
    );
  }
  if (seller.registrationNumber != null) {
    lines.push(labels.registrationNumber.replace('{id}', seller.registrationNumber));
  }
  if (seller.email != null) lines.push(seller.email);
  if (seller.phone != null) lines.push(seller.phone);
  return lines;
}

/** The seller settings (one query, no cache: PDFs are rendered on demand). */
async function loadInvoiceSeller(): Promise<InvoiceSeller> {
  const rows = await client`
    SELECT key, value FROM settings WHERE key = ANY(${SELLER_SETTING_KEYS}::text[])
  `;
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    const { key, value } = row as { key: string; value: unknown };
    settings[key] = value;
  }
  return readInvoiceSeller(settings);
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

function ensureSpace(
  doc: PDFKit.PDFDocument,
  y: number,
  needed: number,
  pageBottom: number,
): number {
  if (y + needed > pageBottom) {
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

  const [seller, branding] = await Promise.all([loadInvoiceSeller(), loadPdfBranding()]);

  const doc = new PDFDocument({
    margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN },
    size: 'A4',
    layout: 'portrait',
    bufferPages: true,
  });
  const fonts = registerPdfFonts(doc, language);
  const footer = layoutPdfFooter(doc, branding.footer, CONTENT_WIDTH);
  // A footer taller than the bottom margin moves the content limit up.
  const pageBottom = PAGE_BOTTOM - (reservePdfFooterSpace(doc, footer, MARGIN) - MARGIN);
  const ensure = (y: number, needed: number): number => ensureSpace(doc, y, needed, pageBottom);
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

  // Header: the PDF logo on the left, invoice meta on the right.
  try {
    doc.image(branding.logo, MARGIN, MARGIN, { fit: [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT] });
  } catch (err) {
    logger.warn({ err }, 'pdfkit rejected the PDF logo, using the default logo');
    doc.image(defaultPdfLogoPng(), MARGIN, MARGIN, { fit: [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT] });
  }
  const headerBottom = MARGIN + LOGO_MAX_HEIGHT;

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

  // The seller: name, address, tax ID, registration number and contact. The
  // operator's text can hold characters the document font lacks.
  const sellerLines = sellerDetailLines(seller, labels);
  const sellerFonts = registerPdfTextFonts(doc, fonts, [seller.name, ...sellerLines].join('\n'));
  const sellerWidth = CONTENT_WIDTH / 2;
  doc.fontSize(9).font(fonts.bold).fillColor(COLOR_MUTED).text(labels.from, rightX, y);
  doc
    .fontSize(11)
    .font(sellerFonts.regular)
    .fillColor(COLOR_TEXT)
    .text(seller.name, rightX, y + 12, { width: sellerWidth });
  let sellerY = y + 12 + Math.max(15, doc.heightOfString(seller.name, { width: sellerWidth }));
  doc.fontSize(10).fillColor(COLOR_MUTED);
  for (const sellerLine of sellerLines) {
    doc.text(sellerLine, rightX, sellerY, { width: sellerWidth });
    sellerY += Math.max(14, doc.heightOfString(sellerLine, { width: sellerWidth }));
  }

  y = Math.max(y + 50, detailY + 10, sellerY + 10);

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
    y = ensure(y, 30);
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
      y = ensure(y, 50);
      const name = group.driverName !== '' ? group.driverName : labels.unknownDriver;
      doc.font(fonts.bold).fontSize(10).fillColor(COLOR_TEXT).text(name, MARGIN, y, {
        width: CONTENT_WIDTH,
      });
      y += 16;
      for (const item of group.items) drawItem(item);
      y = ensure(y, 20);
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
  y = ensure(y, 30 + taxBreakdown.length * 16);
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
  y = ensure(y, 10 + 16 + 16 + 20 + 20);
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
    const noteY = ensure(y + 16, 24);
    doc.text(labels.creditNotePaidNote, MARGIN, noteY, { width: CONTENT_WIDTH });
  }

  drawPdfFooter(doc, footer, MARGIN, CONTENT_WIDTH);
  doc.end();
  return built;
}
