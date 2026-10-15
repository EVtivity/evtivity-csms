// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { parseTrustProxy } from '../trust-proxy.js';

describe('parseTrustProxy', () => {
  it('is off when unset, empty or false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('refuses a hop count, which Fastify ignores', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
    expect(() => parseTrustProxy('0')).toThrow(/hop count/);
  });

  it('refuses true, which trusts every hop', () => {
    expect(() => parseTrustProxy('true')).toThrow(/forge/);
    expect(() => parseTrustProxy('TRUE')).toThrow(/forge/);
  });

  it('takes a list of addresses and CIDRs', () => {
    expect(parseTrustProxy('10.0.0.0/16, 192.168.1.5,fd00::/8')).toBe(
      '10.0.0.0/16,192.168.1.5,fd00::/8',
    );
  });

  it('refuses an invalid address or prefix', () => {
    expect(() => parseTrustProxy('nonsense')).toThrow(/address/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/CIDR/);
    expect(() => parseTrustProxy('fd00::/129')).toThrow(/CIDR/);
    expect(() => parseTrustProxy('10.0.0.0/x')).toThrow(/CIDR/);
    expect(() => parseTrustProxy('10.0.0.0/8/1')).toThrow(/address/);
  });
});
