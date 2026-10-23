// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { parseTrustProxy, proxyEntryProblem } from '../trust-proxy.js';

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

  it('refuses a CIDR that trusts every address', () => {
    expect(() => parseTrustProxy('0.0.0.0/0')).toThrow(/every address/);
    expect(() => parseTrustProxy('10.0.0.0/8,::/0')).toThrow(/every address/);
  });

  it('refuses an IPv4-mapped range that trusts every IPv4 peer', () => {
    expect(() => parseTrustProxy('::ffff:0.0.0.0/96')).toThrow(/every address/);
    expect(() => parseTrustProxy('10.0.0.0/8,::/80')).toThrow(/every address/);
    expect(parseTrustProxy('::ffff:10.0.0.0/104')).toBe('::ffff:10.0.0.0/104');
    // The OCPP parser reads the same rule.
    expect(proxyEntryProblem('::ffff:0.0.0.0/96')).toBe('trust-all');
    expect(proxyEntryProblem('::/80')).toBe('trust-all');
    expect(proxyEntryProblem('fd00::/8')).toBeNull();
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
    expect(() => parseTrustProxy('10.0.0.0/8/1')).toThrow(/CIDR/);
  });

  // Prefixes a loose parser reads as /0.
  it.each(['10.0.0.0/', '10.0.0.0/0x0', '10.0.0.0/0.0', '10.0.0.0/ 0', '::/-0', '10.0.0.0/0000'])(
    'refuses the malformed or trust-all prefix %s',
    (entry) => {
      expect(() => parseTrustProxy(entry)).toThrow(/CIDR|every address/);
      expect(proxyEntryProblem(entry)).not.toBeNull();
    },
  );
});
