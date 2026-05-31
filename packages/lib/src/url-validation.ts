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
  // ::ffff:1.2.3.4 (IPv4-mapped IPv6) and ::1.2.3.4 (IPv4-compatible) embed
  // IPv4 inside an IPv6 literal; surface the IPv4 portion so the IPv4
  // private-range check still fires.
  const match = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(hostname);
  return match?.[1] ?? null;
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
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      return PRIVATE_IPV4_RANGES.some((r) => r.test(hostname));
    }
    if (ipVersion === 6) {
      const embeddedV4 = ipv6MappedIpv4(hostname);
      if (embeddedV4 != null) {
        return PRIVATE_IPV4_RANGES.some((r) => r.test(embeddedV4));
      }
      return PRIVATE_IPV6_PATTERNS.some((r) => r.test(hostname));
    }
    // Block known internal hostname patterns
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
    return false;
  } catch {
    return true; // Invalid URL = treat as private
  }
}
