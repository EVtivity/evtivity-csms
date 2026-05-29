// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { csvEscape, buildCsv } from '../csv-escape.js';

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

    it('prefixes leading CR with a single quote', () => {
      expect(csvEscape('\rmalicious')).toBe("'\rmalicious");
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
  it('joins header and data rows with newlines', () => {
    const out = buildCsv(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    expect(out).toBe('a,b\n1,2\n3,4');
  });

  it('escapes every cell through csvEscape', () => {
    const out = buildCsv(['name', 'value'], [['=danger', 'safe']]);
    expect(out).toBe("name,value\n'=danger,safe");
  });

  it('returns header-only output when rows is empty', () => {
    expect(buildCsv(['a'], [])).toBe('a');
  });
});
