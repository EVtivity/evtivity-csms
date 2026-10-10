// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * PDF branding settings: the logo and the footer drawn on every PDF the
 * platform generates (invoices, credit notes, fleet invoices, reports).
 * Browser-safe, so the CSMS imports it via `@evtivity/lib/pdf-branding`.
 * The SVG sanitizer and the data URI checks live in `pdf-logo.ts` (server).
 */

import { DEFAULT_PDF_LOGO_SVG } from './pdf-logo-default.js';

export { DEFAULT_PDF_LOGO_SVG };

/** A PNG or SVG data URI. Empty (or no row) means the default logo. */
export const PDF_LOGO_KEY = 'pdf.logo';
/** Plain text, centered at the bottom of every page. Empty means no footer. */
export const PDF_FOOTER_KEY = 'pdf.footer';
/** The footer a new install starts with, and the one drawn when no row exists. */
export const DEFAULT_PDF_FOOTER = 'www.evtivity.com';

/** Largest logo file accepted, in bytes (the decoded PNG or SVG). */
export const MAX_PDF_LOGO_BYTES = 512 * 1024;
/** Longest footer accepted, in characters (line breaks included). */
export const MAX_PDF_FOOTER_LENGTH = 500;
/** Most footer lines accepted. Long lines also wrap on the page. */
export const MAX_PDF_FOOTER_LINES = 5;

/**
 * The footer as stored: line breaks normalized to `\n`, each line without
 * trailing spaces, no leading or trailing blank lines, and no control
 * characters. Returns null when the value is not a string, is longer than
 * MAX_PDF_FOOTER_LENGTH, or has more than MAX_PDF_FOOTER_LINES lines.
 */
export function normalizePdfFooter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lines = value
    .replace(/\r\n?/g, '\n')
    // Tabs become spaces; other control characters are dropped.
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  const footer = lines.join('\n');
  if (footer.length > MAX_PDF_FOOTER_LENGTH) return null;
  if (lines.length > MAX_PDF_FOOTER_LINES) return null;
  return footer;
}

/** The default logo as a data URI, for an `<img>` preview. */
export function defaultPdfLogoDataUri(): string {
  return `data:image/svg+xml,${encodeURIComponent(DEFAULT_PDF_LOGO_SVG)}`;
}
