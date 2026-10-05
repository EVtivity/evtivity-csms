// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildCsv } from '../report-generators/csv-builder.js';

describe('buildCsv', () => {
  // UTF-8 BOM character emitted at the start of every output so Excel for
  // Windows detects the encoding. CRLF line terminator per RFC 4180.
  const BOM = '﻿';

  it('builds CSV with headers and rows', () => {
    const result = buildCsv(
      ['Name', 'Age', 'City'],
      [
        ['Alice', 30, 'Denver'],
        ['Bob', 25, 'Austin'],
      ],
    );
    expect(result).toBe(`${BOM}Name,Age,City\r\nAlice,30,Denver\r\nBob,25,Austin`);
  });

  it('escapes values containing commas', () => {
    const result = buildCsv(['Name', 'Address'], [['Alice', '123 Main St, Suite 4']]);
    expect(result).toBe(`${BOM}Name,Address\r\nAlice,"123 Main St, Suite 4"`);
  });

  it('escapes values containing double quotes by doubling them', () => {
    const result = buildCsv(['Name', 'Nickname'], [['Alice', 'The "Great"']]);
    expect(result).toBe(`${BOM}Name,Nickname\r\nAlice,"The ""Great"""`);
  });

  it('escapes values containing newlines', () => {
    const result = buildCsv(['Name', 'Bio'], [['Alice', 'Line one\nLine two']]);
    expect(result).toBe(`${BOM}Name,Bio\r\nAlice,"Line one\nLine two"`);
  });

  it('handles null and undefined values as empty strings', () => {
    const result = buildCsv(['A', 'B', 'C'], [[null, undefined, 'value']]);
    expect(result).toBe(`${BOM}A,B,C\r\n,,value`);
  });

  it('handles numbers and booleans', () => {
    const result = buildCsv(['Count', 'Price', 'Active'], [[42, 9.99, true]]);
    expect(result).toBe(`${BOM}Count,Price,Active\r\n42,9.99,true`);
  });

  it('handles empty rows array', () => {
    const result = buildCsv(['Name', 'Age'], []);
    expect(result).toBe(`${BOM}Name,Age`);
  });

  it('handles objects via JSON.stringify', () => {
    const result = buildCsv(['Name', 'Meta'], [['Alice', { role: 'admin' }]]);
    expect(result).toBe(`${BOM}Name,Meta\r\nAlice,"{""role"":""admin""}"`);
  });
});
