// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Excel/Sheets/Numbers treat cells starting with =, +, -, @, or a TAB/CR
// as formulas, so a malicious site/driver name like `=cmd|...` would
// execute when the CSV is opened. Prefix with a single quote to neutralise
// the formula trigger while keeping the value visually unchanged in most
// clients.
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

function csvEscape(value: unknown): string {
  if (value == null) return '';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    str = String(value);
  } else {
    str = JSON.stringify(value);
  }
  // Sanitize formula-trigger characters at the start of a string cell
  // before we decide whether to quote.
  const firstChar = str.charAt(0);
  if (typeof value === 'string' && firstChar !== '' && FORMULA_PREFIXES.has(firstChar)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const headerLine = headers.map(csvEscape).join(',');
  const dataLines = rows.map((row) => row.map(csvEscape).join(','));
  return [headerLine, ...dataLines].join('\n');
}
