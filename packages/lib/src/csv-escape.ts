// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Excel, Google Sheets, Numbers, and LibreOffice treat a cell whose first
// character is `=`, `+`, `-`, `@`, TAB, or CR as a formula. An attacker who
// gets a malicious string into an exported field (driver name, site name,
// idToken, ...) can execute arbitrary actions when an operator opens the
// CSV. Prefix with a single quote to neutralise the formula trigger while
// keeping the displayed value the same in most clients (the leading quote
// is treated as a "text" marker and not shown).
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

export function csvEscape(value: unknown): string {
  if (value == null) return '';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    str = String(value);
  } else {
    str = JSON.stringify(value);
  }
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
