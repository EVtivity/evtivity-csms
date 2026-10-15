// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isIP } from 'node:net';

/**
 * Parses the TRUST_PROXY setting into Fastify's `trustProxy` option.
 *
 * - empty (default): trust no proxy, the socket address is the client.
 * - a comma-separated list of IP addresses or CIDRs: the proxies to trust
 *   (the load balancer subnets). The client is the rightmost X-Forwarded-For
 *   hop that is not a trusted proxy, so a forged leftmost entry is ignored.
 *
 * `true` (trust every hop) is refused: the client then picks its own address
 * through X-Forwarded-For. A hop count is refused too: Fastify 5 ignores a
 * numeric trustProxy (it cannot check the immediate peer), so it would
 * silently trust nothing. Any invalid entry throws, so the process does not
 * start with a setting it would ignore.
 */
export function parseTrustProxy(value: string | undefined): false | string {
  const raw = (value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop, which lets a client forge its address: list the proxy addresses or CIDRs',
    );
  }
  if (/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY=${raw}: a hop count is not supported (Fastify ignores it), list the proxy addresses or CIDRs`,
    );
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const entry of entries) {
    const [address = '', prefixText, extra] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || extra !== undefined) {
      throw new Error(`Invalid TRUST_PROXY address: ${entry}`);
    }
    if (prefixText === undefined) continue;
    const prefix = Number(prefixText);
    if (
      !/^\d+$/.test(prefixText) ||
      !Number.isInteger(prefix) ||
      prefix > (family === 6 ? 128 : 32)
    ) {
      throw new Error(`Invalid TRUST_PROXY CIDR: ${entry}`);
    }
  }
  return entries.join(',');
}
