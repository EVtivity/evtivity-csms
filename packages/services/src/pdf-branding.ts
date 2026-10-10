// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Resvg } from '@resvg/resvg-js';
import { client } from '@evtivity/database';
import {
  DEFAULT_PDF_LOGO_SVG,
  DEFAULT_PDF_FOOTER,
  PDF_FOOTER_KEY,
  PDF_LOGO_KEY,
  createLogger,
  decodePdfLogo,
  normalizePdfFooter,
  sanitizeSvg,
} from '@evtivity/lib';
import { registerPdfFooterFont } from './cjk-fonts.js';

const logger = createLogger('pdf-branding');

/**
 * Width in pixels an SVG logo is rasterized to. A logo is drawn at most 160
 * points wide, so this keeps it sharp at about 450 dpi.
 */
const SVG_RENDER_WIDTH = 1000;

const FOOTER_FONT_SIZE = 8;
const FOOTER_LINE_GAP = 1;
/** Space between the last footer line and the bottom edge of the page. */
const FOOTER_BOTTOM_OFFSET = 24;
/** Space kept free between the page content and the footer. */
const FOOTER_CONTENT_GAP = 12;
const FOOTER_COLOR = '#64748b';

/** The logo and footer every generated PDF draws (`pdf.logo`, `pdf.footer`). */
export interface PdfBranding {
  /** PNG or JPEG bytes pdfkit embeds. Never empty: the default logo when unset. */
  logo: Buffer;
  /** True when the logo is the default EVtivity logo. */
  isDefaultLogo: boolean;
  /** Plain text, '' for no footer. Never translated. */
  footer: string;
}

function rasterizeSvg(svg: string): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: SVG_RENDER_WIDTH } });
  return Buffer.from(resvg.render().asPng());
}

let defaultLogoPng: Buffer | undefined;

/** The default logo as PNG, rendered once per process. */
export function defaultPdfLogoPng(): Buffer {
  defaultLogoPng ??= rasterizeSvg(sanitizeSvg(DEFAULT_PDF_LOGO_SVG) ?? DEFAULT_PDF_LOGO_SVG);
  return defaultLogoPng;
}

/**
 * The stored `pdf.logo` as PNG or JPEG bytes, or null when it is unset or
 * cannot be used. An SVG is sanitized again before it is rasterized, because
 * a value written straight to the database (Helm appSettings, a restore) never
 * went through the settings route.
 */
export function resolvePdfLogo(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const logo = decodePdfLogo(value, { allowJpeg: true });
  if (logo == null) {
    logger.warn('pdf.logo is not a valid PNG, JPEG or SVG data URI, using the default logo');
    return null;
  }
  if (logo.kind !== 'svg') return logo.data;
  try {
    return rasterizeSvg(logo.svg);
  } catch (err) {
    logger.warn({ err }, 'Failed to render the pdf.logo SVG, using the default logo');
    return null;
  }
}

/**
 * Reads `pdf.logo` and `pdf.footer`. A missing or unusable logo is the
 * default logo, a missing footer row the default footer. An empty footer
 * (the operator cleared it) draws no footer.
 */
export async function loadPdfBranding(): Promise<PdfBranding> {
  const rows = await client`
    SELECT key, value FROM settings WHERE key IN (${PDF_LOGO_KEY}, ${PDF_FOOTER_KEY})
  `;
  let logoValue: unknown = null;
  let footerValue: unknown = DEFAULT_PDF_FOOTER;
  for (const row of rows) {
    const { key, value } = row as { key: string; value: unknown };
    if (key === PDF_LOGO_KEY) logoValue = value;
    else if (key === PDF_FOOTER_KEY) footerValue = value;
  }
  const logo = resolvePdfLogo(logoValue);
  const footer = normalizePdfFooter(footerValue);
  if (footer == null) logger.warn('pdf.footer is not a valid footer, leaving the footer out');
  return {
    logo: logo ?? defaultPdfLogoPng(),
    isDefaultLogo: logo == null,
    footer: footer ?? '',
  };
}

/** Where the footer goes on a page, decided once per document. */
export interface PdfFooterLayout {
  text: string;
  font: string;
  /** Height of the footer text block. 0 without a footer. */
  height: number;
  /** Space the page content must leave free at the bottom of each page. */
  reserve: number;
}

/**
 * Measures the footer for a document whose content is `width` points wide.
 * The footer font depends only on the footer text (Helvetica, or Noto Sans
 * CJK for other scripts), so every PDF draws the same footer whatever its
 * language.
 */
export function layoutPdfFooter(
  doc: PDFKit.PDFDocument,
  footer: string,
  width: number,
): PdfFooterLayout {
  if (footer === '') return { text: '', font: 'Helvetica', height: 0, reserve: 0 };
  const font = registerPdfFooterFont(doc, footer);
  doc.font(font).fontSize(FOOTER_FONT_SIZE);
  const height = doc.heightOfString(footer, {
    width,
    align: 'center',
    lineGap: FOOTER_LINE_GAP,
  });
  return {
    text: footer,
    font,
    height,
    reserve: FOOTER_BOTTOM_OFFSET + height + FOOTER_CONTENT_GAP,
  };
}

/**
 * Sets the bottom margin of the current and every later page to at least the
 * footer's reserve, so text pdfkit flows onto new pages stays above the
 * footer. The document must be created with `margins` (not `margin`).
 * Returns the bottom margin in effect.
 */
export function reservePdfFooterSpace(
  doc: PDFKit.PDFDocument,
  layout: PdfFooterLayout,
  minBottom: number,
): number {
  const bottom = Math.max(minBottom, layout.reserve);
  doc.page.margins.bottom = bottom;
  if (doc.options.margins != null) doc.options.margins.bottom = bottom;
  return bottom;
}

/**
 * Draws the footer centered at the bottom of every page. The document must be
 * created with `bufferPages: true`; call it once, right before `doc.end()`.
 */
export function drawPdfFooter(
  doc: PDFKit.PDFDocument,
  layout: PdfFooterLayout,
  x: number,
  width: number,
): void {
  if (layout.text === '') return;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { margins } = doc.page;
    const bottomMargin = margins.bottom;
    // Text below the bottom margin would make pdfkit open a new page.
    margins.bottom = 0;
    const y = doc.page.height - FOOTER_BOTTOM_OFFSET - layout.height;
    doc
      .font(layout.font)
      .fontSize(FOOTER_FONT_SIZE)
      .fillColor(FOOTER_COLOR)
      .text(layout.text, x, y, { width, align: 'center', lineGap: FOOTER_LINE_GAP });
    margins.bottom = bottomMargin;
  }
}
