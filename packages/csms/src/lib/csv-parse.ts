// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Normalize a CSV file's raw text for parsing. Strips a UTF-8 BOM (Excel
// saves this by default) and converts CRLF/lone-CR line endings to LF so the
// last column on each line doesn't end up with a trailing \r that breaks
// indexOf-based column lookups.
export function readCsvText(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return noBom.replace(/\r\n?/g, '\n');
}

// Parse a single RFC 4180 CSV line into an array of fields. Handles quoted
// values, embedded commas inside quotes, and escaped quotes (`""`). Used by
// the CSV import paths on the Sites and Tokens pages.
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (inQuotes) {
      if (char === '"' && line.charAt(i + 1) === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
