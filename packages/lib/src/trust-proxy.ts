// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isIP } from 'node:net';
import { ipv6Groups } from './ip-address.js';

/**
 * Parses the TRUST_PROXY setting into Fastify's `trustProxy` option.
 *
 * - empty (default): trust no proxy, the socket address is the client.
 * - a comma-separated list of IP addresses or CIDRs: the proxies to trust
 *   (the load balancer subnets). The client is the rightmost X-Forwarded-For
 *   hop that is not a trusted proxy, so a forged leftmost entry is ignored.
 *
 * `true` (trust every hop) and a CIDR that trusts every peer (`/0`, or an IPv6
 * range holding every IPv4-mapped address, `trustsEveryPeer`) are refused:
 * the client then picks its own address through X-Forwarded-For. A hop count is refused too: Fastify 5 ignores a
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
    const problem = proxyEntryProblem(entry);
    if (problem === 'address') throw new Error(`Invalid TRUST_PROXY address: ${entry}`);
    if (problem === 'cidr') throw new Error(`Invalid TRUST_PROXY CIDR: ${entry}`);
    if (problem === 'trust-all') {
      throw new Error(
        `TRUST_PROXY=${entry} trusts every address, which lets a client forge its address: list the proxy addresses or CIDRs`,
      );
    }
  }
  return entries.join(',');
}

// ::ffff:0:0/96, the IPv4-mapped range: a trusted range that holds it trusts
// every IPv4 peer, since proxy checks compare an IPv4 peer in that form.
const IPV4_MAPPED_GROUPS = [0, 0, 0, 0, 0, 0xffff, 0, 0];

/**
 * Whether one proxy list entry trusts every peer of a family: a `/0` CIDR
 * (`0.0.0.0/0`, `::/0`), or an IPv6 CIDR of prefix 96 or less that holds the
 * whole IPv4-mapped range (`::ffff:0.0.0.0/96`, `::/80`: every IPv4 peer).
 * Trusting every peer lets any client choose its address with
 * `X-Forwarded-For`.
 */
export function trustsEveryPeer(entry: string): boolean {
  const [address = '', prefixText] = entry.trim().split('/');
  if (prefixText == null || !/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix === 0) return true;
  if (!address.includes(':') || prefix > 96) return false;
  const groups = ipv6Groups(address);
  if (groups == null) return false;
  for (let bit = 0; bit < prefix; bit++) {
    const group = Math.floor(bit / 16);
    const mask = 1 << (15 - (bit % 16));
    if (((groups[group] ?? 0) & mask) !== ((IPV4_MAPPED_GROUPS[group] ?? 0) & mask)) return false;
  }
  return true;
}

export interface ProxyEntry {
  address: string;
  family: 4 | 6;
  /** The CIDR prefix length, or undefined for a single address. */
  prefix: number | undefined;
}

/**
 * Why one trusted proxy entry is refused, or null. The prefix must be 1 to 3
 * digits after a single `/`, within the address family, and never 0: a loose
 * parser (`Number('')`, `Number('0x0')`, `Number(' 0')`) reads `10.0.0.0/`,
 * `/0x0` or `/ 0` as /0, a subnet that trusts every peer. An IPv6 range of
 * prefix 96 or less that holds the IPv4-mapped addresses (`::ffff:0.0.0.0/96`,
 * `::/80`) trusts every IPv4 peer too (`trustsEveryPeer`). The API, OCPI and
 * OCPP configs all decide on this one function.
 */
export function proxyEntryProblem(entry: string): 'address' | 'cidr' | 'trust-all' | null {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return 'address';
  if (slash === -1) return null;
  const prefixText = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return 'cidr';
  const prefix = Number(prefixText);
  if (prefix > (family === 6 ? 128 : 32)) return 'cidr';
  if (prefix === 0 || trustsEveryPeer(entry)) return 'trust-all';
  return null;
}

/** Parses one trusted proxy entry strictly (`proxyEntryProblem`), or throws. */
export function parseProxyEntry(entry: string): ProxyEntry {
  const problem = proxyEntryProblem(entry);
  if (problem === 'address') throw new Error(`Invalid trusted proxy address: ${entry}`);
  if (problem === 'cidr') throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
  if (problem === 'trust-all') throw new Error(`Trusted proxy ${entry} trusts every address`);
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  return {
    address,
    family: isIP(address) === 6 ? 6 : 4,
    prefix: slash === -1 ? undefined : Number(entry.slice(slash + 1)),
  };
}
