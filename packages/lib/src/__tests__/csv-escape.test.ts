// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { csvEscape, buildCsv, neutraliseSpreadsheetFormula } from '../csv-escape.js';

describe('csvEscape', () => {
  it('returns plain ASCII unchanged', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('ABC123')).toBe('ABC123');
  });

  it('quotes values containing commas, quotes, or newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });

  it('null and undefined become empty strings', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('empty string passes through the formula-neutralise step unchanged', () => {
    // Hits the early `value === ''` return inside neutraliseSpreadsheetFormula.
    expect(csvEscape('')).toBe('');
  });

  it('numbers and booleans are stringified', () => {
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(true)).toBe('true');
    expect(csvEscape(false)).toBe('false');
  });

  it('objects are JSON-stringified', () => {
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
  });

  describe('formula injection protection', () => {
    it('prefixes leading = with a single quote', () => {
      expect(csvEscape('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    });

    it('prefixes leading + with a single quote', () => {
      expect(csvEscape('+1234')).toBe("'+1234");
    });

    it('prefixes leading - with a single quote', () => {
      expect(csvEscape('-cmd|calc')).toBe("'-cmd|calc");
    });

    it('prefixes leading @ with a single quote', () => {
      expect(csvEscape('@SUM(1+1)')).toBe("'@SUM(1+1)");
    });

    it('prefixes leading TAB with a single quote', () => {
      expect(csvEscape('\tevil')).toBe("'\tevil");
    });

    it('prefixes leading CR with a single quote and wraps in CSV quotes', () => {
      // Output is also CSV-quoted because the value contains a bare CR after
      // the formula-prefix step (RFC 4180 quoting rule).
      expect(csvEscape('\rmalicious')).toBe('"\'\rmalicious"');
    });

    it('does not prefix interior formula chars', () => {
      expect(csvEscape('safe=value')).toBe('safe=value');
    });

    it('only applies formula prefix to strings, not numbers', () => {
      expect(csvEscape(-5)).toBe('-5');
    });

    it('formula prefix combines with quoting when needed', () => {
      expect(csvEscape('=A1,B1')).toBe('"\'=A1,B1"');
    });
  });
});

describe('buildCsv', () => {
  // UTF-8 BOM character emitted at the start of every output so Excel for
  // Windows detects the encoding. CRLF line terminator per RFC 4180.
  const BOM = '﻿';

  it('joins header and data rows with BOM + CRLF', () => {
    const out = buildCsv(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    expect(out).toBe(`${BOM}a,b\r\n1,2\r\n3,4`);
  });

  it('escapes every cell through csvEscape', () => {
    const out = buildCsv(['name', 'value'], [['=danger', 'safe']]);
    expect(out).toBe(`${BOM}name,value\r\n'=danger,safe`);
  });

  it('returns BOM + header-only output when rows is empty', () => {
    expect(buildCsv(['a'], [])).toBe(`${BOM}a`);
  });
});

describe('neutraliseSpreadsheetFormula', () => {
  it('returns empty string untouched without prefixing', () => {
    expect(neutraliseSpreadsheetFormula('')).toBe('');
  });

  it('prefixes a leading formula trigger and leaves the rest intact', () => {
    expect(neutraliseSpreadsheetFormula('=1+1')).toBe("'=1+1");
  });

  it('leaves a safe leading character unchanged', () => {
    expect(neutraliseSpreadsheetFormula('hello')).toBe('hello');
  });
});
