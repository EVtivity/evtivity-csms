// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { buildCsvText, csvCell, downloadCsv } from '../csv-download';

describe('csv-download', () => {
  it('quotes separators and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('neutralises formulas at the start and after a semicolon or TAB', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('-North')).toBe("'-North");
    expect(csvCell('x; =1')).toBe('"x; \'=1"');
  });

  it('builds CRLF rows with a header', () => {
    expect(buildCsvText(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });

  it('writes an object as quoted JSON and leaves numbers and booleans alone', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(['=x'])).toBe('"[""=x""]"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(true)).toBe('true');
  });

  it('saves the text as a CSV file under its name', () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          created.push(b);
          return 'blob:csv';
        },
        revokeObjectURL: (u: string) => {
          revoked.push(u);
        },
      }),
    );
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    downloadCsv('terminals.csv', 'a\r\n');
    expect(names).toEqual(['terminals.csv']);
    expect(created[0]?.type).toBe('text/csv;charset=utf-8');
    expect(revoked).toEqual(['blob:csv']);
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
