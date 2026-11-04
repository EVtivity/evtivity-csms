// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A CSV file built in the browser from data the page already holds, for an
// Export CSV button that has no export route. A cell that a spreadsheet would
// read as a formula (=, +, -, @, TAB or CR first, or after a ; or TAB that a
// semicolon locale splits on) gets a leading quote, as the server exports do.

const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);
const SPLIT_FORMULA = /([;\t]\s*)([=+\-@])/g;

/** One CSV cell: formula characters neutralised, quoted when it holds a separator. */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  // Every value but a number or a boolean holds text a person may have typed.
  if (typeof value !== 'number' && typeof value !== 'boolean') {
    if (text.length > 0 && FORMULA_START.has(text.charAt(0))) text = `'${text}`;
    text = text.replace(SPLIT_FORMULA, "$1'$2");
  }
  return /[",;\t\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV text of a header row and data rows (CRLF line ends). */
export function buildCsvText(headers: readonly string[], rows: readonly unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Saves the CSV text as a file. */
export function downloadCsv(fileName: string, text: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}
