// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Excel, Google Sheets, Numbers, and LibreOffice treat a cell whose first
// character is `=`, `+`, `-`, `@`, TAB, or CR as a formula. An attacker who
// gets a malicious string into an exported field (driver name, site name,
// idToken, ...) can execute arbitrary actions when an operator opens the
// CSV/XLSX. Prefix with a single quote to neutralise the formula trigger
// while keeping the displayed value the same in most clients (the leading
// quote is treated as a "text" marker and not shown).
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

// Excel opening a .csv in a locale whose list separator is ';' (de, es)
// splits a field on it, quotes or not, when the field does not start the
// line, and a tab-separated import splits on TAB. A formula character after
// one of them would then start a new cell (OWASP CSV Injection), so a single
// quote goes in front of it. A comma inside a quoted field never splits it.
// Whitespace between the separator and the formula character does not stop
// it. A linear scan, not a regular expression: `[;\t]\s*` backtracks
// quadratically on a long run of TABs, and exports hold user-typed text.
const SPLIT_SEPARATORS = new Set([';', '\t']);
const SPLIT_FORMULA_CHARS = new Set(['=', '+', '-', '@']);
const WHITESPACE = /\s/;

function neutraliseSplitFormulas(text: string): string {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!SPLIT_SEPARATORS.has(text.charAt(i))) {
      i++;
      continue;
    }
    // Every separator inside this whitespace run ends at the same character,
    // so the run is read once.
    let j = i + 1;
    while (j < text.length && WHITESPACE.test(text.charAt(j))) j++;
    if (j < text.length && SPLIT_FORMULA_CHARS.has(text.charAt(j))) {
      out += `${text.slice(copied, j)}'`;
      copied = j;
      j++;
    }
    i = j;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

export function neutraliseSpreadsheetFormula(value: string): string {
  if (value === '') return value;
  return FORMULA_PREFIXES.has(value.charAt(0)) ? `'${value}` : value;
}

export function csvEscape(value: unknown): string {
  if (value == null) return '';
  let str: string;
  if (typeof value === 'number' || typeof value === 'boolean') {
    // A number or boolean is never text a person typed: `-5` stays a number.
    str = String(value);
  } else {
    // Every other value (strings, and objects, arrays or dates serialized as
    // JSON) is neutralized, so text inside a serialized value cannot start a
    // formula either.
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    str = neutraliseSplitFormulas(neutraliseSpreadsheetFormula(text));
  }
  // RFC 4180: fields containing CR, LF, comma, or double-quote must be
  // enclosed in double-quotes. Without quoting bare CR, an embedded \r in
  // user data would inject a line break into the output. A semicolon or TAB
  // is quoted too: Excel splits on the locale list separator (';' in de and
  // es) and a tab-separated import on TAB.
  if (/[,"\n\r;\t]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// UTF-8 BOM so Excel for Windows detects the encoding correctly. Without it
// the default codepage (cp1252) corrupts non-ASCII characters (driver names
// with accents, €/£ symbols, OCPP error messages in non-English locales).
const UTF8_BOM = '﻿';

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const headerLine = headers.map(csvEscape).join(',');
  const dataLines = rows.map((row) => row.map(csvEscape).join(','));
  // CRLF line terminator per RFC 4180. LF works in modern tools but trips up
  // older Excel/Windows imports.
  return UTF8_BOM + [headerLine, ...dataLines].join('\r\n');
}
