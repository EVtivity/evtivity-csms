// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { parseCsvLine, readCsvText } from '../csv-parse';

describe('readCsvText', () => {
  it('strips a UTF-8 BOM from the start of the input', () => {
    expect(readCsvText('﻿siteName,stationId')).toBe('siteName,stationId');
  });

  it('passes through input without a BOM unchanged', () => {
    expect(readCsvText('siteName,stationId')).toBe('siteName,stationId');
  });

  it('converts CRLF line endings to LF', () => {
    expect(readCsvText('a,b\r\nc,d\r\n')).toBe('a,b\nc,d\n');
  });

  it('converts lone CR line endings to LF', () => {
    expect(readCsvText('a,b\rc,d\r')).toBe('a,b\nc,d\n');
  });

  it('handles BOM combined with CRLF', () => {
    expect(readCsvText('﻿a,b\r\nc,d')).toBe('a,b\nc,d');
  });

  it('returns empty string for empty input', () => {
    expect(readCsvText('')).toBe('');
  });
});

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves empty fields', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
    expect(parseCsvLine(',,')).toEqual(['', '', '']);
  });

  it('respects quoted fields with embedded commas', () => {
    expect(parseCsvLine('a,"Acme, LLC",c')).toEqual(['a', 'Acme, LLC', 'c']);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsvLine('a,"He said ""hi""",c')).toEqual(['a', 'He said "hi"', 'c']);
  });

  it('handles a single trailing empty field', () => {
    expect(parseCsvLine('Airport Lot,,,,,,,,,,,')).toEqual([
      'Airport Lot',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('returns a single empty string for an empty line', () => {
    expect(parseCsvLine('')).toEqual(['']);
  });
});
