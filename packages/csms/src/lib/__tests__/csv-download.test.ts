// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildCsvText, csvCell } from '../csv-download';

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
});
