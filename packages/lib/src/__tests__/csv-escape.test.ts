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
    it('neutralizes a formula inside an object, an array and a date too', () => {
      // A formula after a line break or a separator inside a serialized object.
      const obj = csvEscape({ a: '\n=HYPERLINK("https://attacker.example")', b: 'x;=1+1' });
      expect(obj).toContain(";'=1+1");
      expect(obj.startsWith('"{')).toBe(true);
      const arr = csvEscape(['ok', ';=HYPERLINK("https://attacker.example")']);
      expect(arr).toContain(";'=HYPERLINK");
      expect(arr.startsWith('"[')).toBe(true);
      const date = csvEscape(new Date('2026-10-23T10:00:00Z'));
      expect(date).toBe('"""2026-10-23T10:00:00.000Z"""');
      expect(csvEscape(null)).toBe('');
      expect(csvEscape(undefined)).toBe('');
      // Numbers and booleans stay as they are.
      expect(csvEscape(-5)).toBe('-5');
      expect(csvEscape(false)).toBe('false');
    });

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
      // A TAB also splits a field in a tab-separated import, so the field is quoted.
      expect(csvEscape('\tevil')).toBe('"\'\tevil"');
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

    it('quotes a field with a semicolon or TAB and breaks a formula after it (review 2, AI L2)', () => {
      // Excel in de and es splits a .csv on ';', so the part after it is its own cell.
      expect(csvEscape('x;=HYPERLINK("https://attacker.example","Open")')).toBe(
        '"x;\'=HYPERLINK(""https://attacker.example"",""Open"")"',
      );
      expect(csvEscape('a; +1+1')).toBe('"a; \'+1+1"');
      expect(csvEscape('a\t@SUM(1)')).toBe('"a\t\'@SUM(1)"');
      expect(csvEscape('a;b')).toBe('"a;b"');
      // A comma inside a quoted field never splits it, in any locale.
      expect(csvEscape('Smith, -5')).toBe('"Smith, -5"');
      // No cell of a semicolon or TAB split of the field starts with a formula character.
      for (const value of ['x;=1+1', 'a;;-2+3', 'b;\t=1', 'c; @x']) {
        for (const cell of csvEscape(value).split(/[;\t]/).slice(1)) {
          expect(/^\s*[=+\-@]/.test(cell), `${value}: ${cell}`).toBe(false);
        }
      }
    });

    it('scans a long run of TABs or semicolons in linear time', () => {
      for (const crafted of ['\t'.repeat(100_000), `x${';\t '.repeat(50_000)}y`]) {
        const started = performance.now();
        csvEscape(crafted);
        expect(performance.now() - started).toBeLessThan(50);
      }
      expect(csvEscape(`a${'\t'.repeat(1000)}=1`)).toBe(`"a${'\t'.repeat(1000)}'=1"`);
    });

    it('breaks split formulas exactly as the reference pattern does', () => {
      const reference = (value: string) => value.replace(/([;\t]\s*)([=+\-@])/g, "$1'$2");
      const alphabet = [';', '\t', ' ', '\n', '=', '+', '-', '@', 'a', ' '];
      let seed = 7;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed;
      };
      for (let n = 0; n < 5000; n++) {
        let value = 'x';
        const length = next() % 12;
        for (let k = 0; k < length; k++) value += alphabet[next() % alphabet.length] ?? '';
        const expected = reference(value);
        expect(csvEscape(value)).toBe(
          /[,"\n\r;\t]/.test(expected) ? `"${expected.replace(/"/g, '""')}"` : expected,
        );
      }
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
