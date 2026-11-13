// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isIP } from 'node:net';

/**
 * The eight 16-bit groups of a valid IPv6 address, or null. A dotted IPv4
 * tail (`::ffff:192.0.2.1`) counts as two groups; each octet must be 0 to 255
 * and each group one to four hex digits. A zone suffix (`%eth0`) is ignored.
 * The one IPv6 parser of the platform: every address check that looks inside
 * an IPv6 address uses it, so they agree on every spelling.
 */
export function ipv6Groups(address: string): number[] | null {
  let text = (address.split('%')[0] ?? address).toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 != null) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] == null || halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => Number.parseInt(p, 16));
}

/** Dotted IPv4 text of two 16-bit groups. */
export function groupsToIpv4(high: number, low: number): string {
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
}

/**
 * The IPv4 address of an IPv4-mapped IPv6 address (`::ffff:0:0/96`), in the
 * dotted (`::ffff:192.0.2.1`) and the hex (`::ffff:c000:201`) form alike, or
 * null for any other text.
 */
export function mappedIpv4(address: string): string | null {
  if (isIP(address.split('%')[0] ?? address) !== 6) return null;
  const groups = ipv6Groups(address);
  if (groups == null) return null;
  if (!groups.slice(0, 5).every((g) => g === 0) || groups[5] !== 0xffff) return null;
  return groupsToIpv4(groups[6] ?? 0, groups[7] ?? 0);
}

/**
 * An address as a peer check compares it: an IPv4-mapped IPv6 address
 * (dotted or hex) as its IPv4 form, anything else as given.
 */
export function normalizeMappedIp(address: string): string {
  return mappedIpv4(address) ?? address;
}

/**
 * The key a per-client budget counts an address under: an IPv4 address as is
 * (an IPv4-mapped IPv6 address, dotted or hex, as its IPv4 form), an IPv6
 * address by its /64 prefix (`2001:db8:1:2::/64`). One IPv6 host usually gets
 * a whole /64 (RFC 6177, RFC 7421), so a budget per full address would let it
 * rotate addresses past every limit. Anything else is returned as given.
 * `ipv6Prefix` 48 groups an IPv6 address by its /48 instead (`2001:db8:1::/48`),
 * the usual size of one site allocation, for a limit that one allocation must
 * not multiply by its 65,536 /64s.
 */
export function clientAddressKey(ip: string, ipv6Prefix: 48 | 64 = 64): string {
  if (isIP(ip) === 4) return ip;
  const address = ip.split('%')[0] ?? ip;
  if (isIP(address) !== 6) return ip;
  const mapped = mappedIpv4(address);
  if (mapped != null) return mapped;
  const groups = ipv6Groups(address);
  if (groups == null) return ip;
  return `${groups
    .slice(0, ipv6Prefix / 16)
    .map((g) => g.toString(16))
    .join(':')}::/${String(ipv6Prefix)}`;
}

/**
 * A device address as typed by a person, in canonical form, or null when it
 * is not one plain IPv4 or IPv6 address. Surrounding spaces are trimmed; a
 * port, a prefix length (`/24`), a zone (`%eth0`), brackets and host names
 * are refused. IPv4 stays dotted (Node refuses leading zeros); IPv6 follows
 * RFC 5952 section 4: lower case, no leading zeros in a group, the longest run
 * of two or more zero groups (the first of equal runs) as `::`, and an
 * IPv4-mapped address with its dotted tail (`::ffff:192.0.2.1`).
 */
export function canonicalIpAddress(text: string): string | null {
  const value = text.trim();
  if (isIP(value) === 4) return value;
  if (value.includes('%') || isIP(value) !== 6) return null;
  const groups = ipv6Groups(value);
  if (groups == null) return null;
  const mapped = mappedIpv4(value);
  if (mapped != null) return `::ffff:${mapped}`;
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}
