// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { clientAddressKey, ipv6Groups, mappedIpv4, normalizeMappedIp } from '../ip-address.js';

describe('clientAddressKey', () => {
  it('keeps an IPv4 address', () => {
    expect(clientAddressKey('203.0.113.9')).toBe('203.0.113.9');
  });

  it('counts two addresses of one IPv6 /64 as one client', () => {
    const a = clientAddressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = clientAddressKey('2001:db8:1:2::1');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(clientAddressKey('2001:db8:1:3::1')).not.toBe(a);
  });

  it('groups IPv6 by its /48 on request, and keeps IPv4 and mapped addresses as they are', () => {
    const a = clientAddressKey('2001:db8:1:2::1', 48);
    expect(a).toBe('2001:db8:1::/48');
    expect(clientAddressKey('2001:db8:1:ffff::9', 48)).toBe(a);
    expect(clientAddressKey('2001:db8:2:2::1', 48)).not.toBe(a);
    expect(clientAddressKey('203.0.113.9', 48)).toBe('203.0.113.9');
    expect(clientAddressKey('::ffff:203.0.113.9', 48)).toBe('203.0.113.9');
  });

  it('expands compressed and zoned forms', () => {
    expect(clientAddressKey('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientAddressKey('2001:DB8::')).toBe('2001:db8:0:0::/64');
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(clientAddressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddressKey('::ffff:cb00:7109')).toBe('203.0.113.9');
  });

  it('returns anything else as given', () => {
    expect(clientAddressKey('unknown')).toBe('unknown');
    expect(clientAddressKey('')).toBe('');
  });
});

describe('ipv6Groups', () => {
  it('expands every spelling to eight groups', () => {
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('2001:DB8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('::ffff:192.0.2.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x201]);
    expect(ipv6Groups('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('refuses malformed text', () => {
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(ipv6Groups('::ffff:300.0.0.1')).toBeNull();
    expect(ipv6Groups('12345::')).toBeNull();
    expect(ipv6Groups('g::1')).toBeNull();
    expect(ipv6Groups('1:2:3')).toBeNull();
  });
});

describe('IPv4-mapped addresses', () => {
  it('reads the dotted and the hex form alike', () => {
    expect(mappedIpv4('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(mappedIpv4('::ffff:c000:201')).toBe('192.0.2.1');
    expect(mappedIpv4('0:0:0:0:0:FFFF:C000:0201')).toBe('192.0.2.1');
    expect(normalizeMappedIp('::ffff:c000:201')).toBe('192.0.2.1');
    expect(clientAddressKey('::ffff:c000:201')).toBe('192.0.2.1');
  });

  it('leaves other addresses alone', () => {
    expect(mappedIpv4('192.0.2.1')).toBeNull();
    expect(mappedIpv4('::c000:201')).toBeNull();
    expect(mappedIpv4('64:ff9b::c000:201')).toBeNull();
    expect(normalizeMappedIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeMappedIp('unknown')).toBe('unknown');
  });
});
