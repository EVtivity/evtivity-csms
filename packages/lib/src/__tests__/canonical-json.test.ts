// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { aiArgsHash, canonicalJson } from '../canonical-json.js';

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined keys and writes a lone undefined as null', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('aiArgsHash', () => {
  it('hashes equal arguments equally whatever the key order', () => {
    const a = aiArgsHash({ stationId: 'CS-1', transactionId: 'tx' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(aiArgsHash({ transactionId: 'tx', stationId: 'CS-1' })).toBe(a);
    expect(aiArgsHash({ stationId: 'CS-2', transactionId: 'tx' })).not.toBe(a);
  });
});
