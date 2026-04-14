// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { URL } from 'node:url';
import { isIP } from 'node:net';

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '::1') return true;
    if (isIP(hostname)) {
      return PRIVATE_RANGES.some((r) => r.test(hostname));
    }
    // Block known internal hostname patterns
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
    return false;
  } catch {
    return true; // Invalid URL = treat as private
  }
}
