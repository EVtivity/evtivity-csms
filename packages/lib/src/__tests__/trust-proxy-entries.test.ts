// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { parseProxyEntry, trustsEveryPeer } from '../trust-proxy.js';

describe('parseProxyEntry', () => {
  it('parses a single address and a CIDR of either family', () => {
    expect(parseProxyEntry('10.0.0.1')).toEqual({
      address: '10.0.0.1',
      family: 4,
      prefix: undefined,
    });
    expect(parseProxyEntry('10.0.0.0/8')).toEqual({ address: '10.0.0.0', family: 4, prefix: 8 });
    expect(parseProxyEntry('fd00::/8')).toEqual({ address: 'fd00::', family: 6, prefix: 8 });
  });

  it('throws for a bad address, a loose prefix and an entry that trusts every peer', () => {
    expect(() => parseProxyEntry('proxy.local')).toThrow(/Invalid trusted proxy address/);
    expect(() => parseProxyEntry('10.0.0.0/')).toThrow(/Invalid trusted proxy CIDR/);
    expect(() => parseProxyEntry('10.0.0.0/33')).toThrow(/Invalid trusted proxy CIDR/);
    expect(() => parseProxyEntry('0.0.0.0/0')).toThrow(/trusts every address/);
    expect(() => parseProxyEntry('::ffff:0.0.0.0/96')).toThrow(/trusts every address/);
  });
});

describe('trustsEveryPeer', () => {
  it('reads only a plain decimal prefix and an IPv6 range that holds the mapped IPv4 range', () => {
    expect(trustsEveryPeer('10.0.0.0')).toBe(false);
    expect(trustsEveryPeer('10.0.0.0/0x0')).toBe(false);
    expect(trustsEveryPeer(' ::/0 ')).toBe(true);
    expect(trustsEveryPeer('10.0.0.0/8')).toBe(false);
    expect(trustsEveryPeer('::/97')).toBe(false);
    expect(trustsEveryPeer('::/80')).toBe(true);
    expect(trustsEveryPeer('fd00::/80')).toBe(false);
    expect(trustsEveryPeer('not:an:address::zz/64')).toBe(false);
  });
});
