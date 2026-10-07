// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { tryParseJson } from '../safe-json.js';

describe('tryParseJson', () => {
  it('parses valid JSON values', () => {
    expect(tryParseJson('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
    expect(tryParseJson('"text"')).toBe('text');
    expect(tryParseJson('0')).toBe(0);
    expect(tryParseJson('null')).toBeNull();
    expect(tryParseJson('false')).toBe(false);
  });

  it('returns undefined for invalid JSON', () => {
    expect(tryParseJson('{a:1}')).toBeUndefined();
    expect(tryParseJson('')).toBeUndefined();
    expect(tryParseJson('undefined')).toBeUndefined();
  });

  it('returns undefined for a missing text', () => {
    expect(tryParseJson(null)).toBeUndefined();
    expect(tryParseJson(undefined)).toBeUndefined();
  });
});
