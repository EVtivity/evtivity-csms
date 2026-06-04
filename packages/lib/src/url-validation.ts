// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { URL } from 'node:url';
import { isIP } from 'node:net';

const PRIVATE_IPV4_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

// IPv6 private/loopback prefixes. The URL parser lowercases hostnames so
// these patterns assume lowercase input.
// - ::1 loopback, :: unspecified, fc00::/7 ULA, fe80::/10 link-local
const PRIVATE_IPV6_PATTERNS = [/^::1$/, /^::$/, /^fc/, /^fd/, /^fe[89ab]/];

function ipv6MappedIpv4(hostname: string): string | null {
  // ::ffff:1.2.3.4 (IPv4-mapped) and ::1.2.3.4 (IPv4-compatible) embed IPv4 in
  // an IPv6 literal. Node's URL parser normalizes the trailing dotted IPv4 to
  // two hex groups (::ffff:127.0.0.1 -> ::ffff:7f00:1, ::192.168.1.1 ->
  // ::c0a8:101), so decode those groups back to dotted IPv4 and surface it so
  // the IPv4 private-range check still fires.
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (match?.[1] == null || match[2] == null) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
}

export function isPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    // Reject anything that is not a real network protocol. file:// reads
    // local files, gopher:// / dict:// can hit internal services, ftp://
    // is not a webhook target, etc. Only http(s) is acceptable for an
    // outbound webhook delivery.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    const hostname = parsed.hostname;
    if (hostname === '' || hostname === 'localhost') return true;
    // node's URL parser returns IPv6 hosts wrapped in brackets ([::1]), which
    // isIP() does not recognize. Strip them so the IPv6 private-range checks
    // below actually run (otherwise a private IPv6 host like http://[::1] would
    // fall through and be treated as public — an SSRF bypass).
    const host =
      hostname.length > 1 && hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    const ipVersion = isIP(host);
    if (ipVersion === 4) {
      return PRIVATE_IPV4_RANGES.some((r) => r.test(host));
    }
    if (ipVersion === 6) {
      const embeddedV4 = ipv6MappedIpv4(host);
      if (embeddedV4 != null) {
        return PRIVATE_IPV4_RANGES.some((r) => r.test(embeddedV4));
      }
      return PRIVATE_IPV6_PATTERNS.some((r) => r.test(host));
    }
    // Block known internal hostname patterns
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    return false;
  } catch {
    return true; // Invalid URL = treat as private
  }
}
