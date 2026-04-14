// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildCsv } from '../services/report-generators/csv-builder.js';

describe('buildCsv', () => {
  it('builds CSV with headers and rows', () => {
    const result = buildCsv(
      ['Name', 'Age', 'City'],
      [
        ['Alice', 30, 'Denver'],
        ['Bob', 25, 'Austin'],
      ],
    );
    expect(result).toBe('Name,Age,City\nAlice,30,Denver\nBob,25,Austin');
  });

  it('escapes values containing commas', () => {
    const result = buildCsv(['Name', 'Address'], [['Alice', '123 Main St, Suite 4']]);
    expect(result).toBe('Name,Address\nAlice,"123 Main St, Suite 4"');
  });

  it('escapes values containing double quotes by doubling them', () => {
    const result = buildCsv(['Name', 'Nickname'], [['Alice', 'The "Great"']]);
    expect(result).toBe('Name,Nickname\nAlice,"The ""Great"""');
  });

  it('escapes values containing newlines', () => {
    const result = buildCsv(['Name', 'Bio'], [['Alice', 'Line one\nLine two']]);
    expect(result).toBe('Name,Bio\nAlice,"Line one\nLine two"');
  });

  it('handles null and undefined values as empty strings', () => {
    const result = buildCsv(['A', 'B', 'C'], [[null, undefined, 'value']]);
    expect(result).toBe('A,B,C\n,,value');
  });

  it('handles numbers and booleans', () => {
    const result = buildCsv(['Count', 'Price', 'Active'], [[42, 9.99, true]]);
    expect(result).toBe('Count,Price,Active\n42,9.99,true');
  });

  it('handles empty rows array', () => {
    const result = buildCsv(['Name', 'Age'], []);
    expect(result).toBe('Name,Age');
  });

  it('handles objects via JSON.stringify', () => {
    const result = buildCsv(['Name', 'Meta'], [['Alice', { role: 'admin' }]]);
    expect(result).toBe('Name,Meta\nAlice,"{""role"":""admin""}"');
  });
});
