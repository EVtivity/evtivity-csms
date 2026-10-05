// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// SSRF-safe outbound HTTP for URLs that come from a station, a partner, or a
// stored notification recipient. The check runs at connection time, inside
// the DNS lookup the socket connects with: every A and AAAA record of the host
// must be a public address, and the socket connects only to an address that
// passed the check. A DNS answer that changes between a check and the connect
// (DNS rebinding) cannot reach an internal address, and a redirect is checked
// the same way because every connection goes through the same connector.

import dns from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import type { RequestInit, Response } from 'undici';

// IPv4 ranges that are not public unicast: unspecified (0/8), private (10/8,
// 172.16/12, 192.168/16), CGNAT (100.64/10), loopback (127/8), link-local and
// cloud metadata (169.254/16), IETF protocol assignments (192.0.0/24),
// documentation (192.0.2/24, 198.51.100/24, 203.0.113/24), 6to4 relay
// (192.88.99/24), benchmarking (198.18/15), multicast (224/4), reserved and
// broadcast (240/4).
const NON_PUBLIC_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// IPv6 ranges that are not public unicast: unspecified, loopback and the
// deprecated IPv4-compatible block (::/96),
// discard (100::/64), documentation (2001:db8::/32), unique-local (fc00::/7),
// link-local (fe80::/10), deprecated site-local (fec0::/10), multicast
// (ff00::/8). Ranges that embed an IPv4 address (mapped, compatible, NAT64,
// 6to4) are decoded and checked as IPv4 instead.
const NON_PUBLIC_V6: readonly [string, number][] = [
  ['::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

// Ranges no outbound request has a reason to reach, even for a destination
// allowed to use private networks: unspecified, link-local (cloud metadata
// services live at 169.254.169.254 and fd00:ec2::254 is reached through it),
// multicast and reserved.
const UNROUTABLE_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const UNROUTABLE_V6: readonly [string, number][] = [
  ['::', 128],
  ['fe80::', 10],
  ['ff00::', 8],
];

function buildBlockList(
  v4: readonly [string, number][],
  v6: readonly [string, number][],
): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

const blockList = buildBlockList(NON_PUBLIC_V4, NON_PUBLIC_V6);
const unroutableList = buildBlockList(UNROUTABLE_V4, UNROUTABLE_V6);

/** The eight 16-bit groups of a valid IPv6 address (dotted IPv4 tail allowed). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted != null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail == null || tail === '' ? [] : tail.split(':');
  const fill = tail == null ? 0 : 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array<string>(fill).fill('0'), ...tailGroups].map((g) =>
    parseInt(g, 16),
  );
}

function groupsToIpv4(high: number, low: number): string {
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
}

/**
 * The IPv4 address an IPv6 address carries, or null: IPv4-mapped
 * (::ffff:0:0/96), IPv4-compatible (::/96, deprecated), NAT64 (64:ff9b::/96,
 * 64:ff9b:1::/48) and 6to4 (2002::/16).
 */
function embeddedIpv4(groups: number[]): string | null {
  const g = (i: number): number => groups[i] ?? 0;
  const zeroPrefix = (n: number): boolean => groups.slice(0, n).every((v) => v === 0);
  if (zeroPrefix(5) && g(5) === 0xffff) return groupsToIpv4(g(6), g(7));
  // IPv4-compatible; ::/96 with a zero high group is :: or ::1, not an IPv4.
  if (zeroPrefix(6) && g(6) !== 0) return groupsToIpv4(g(6), g(7));
  if (g(0) === 0x64 && g(1) === 0xff9b && (g(2) === 0 || g(2) === 1)) {
    return groupsToIpv4(g(6), g(7));
  }
  if (g(0) === 0x2002) return groupsToIpv4(g(1), g(2));
  return null;
}

/**
 * Whether an IP address is not a public unicast address: private, loopback,
 * link-local, unique-local, CGNAT, multicast, unspecified, documentation,
 * benchmarking or reserved, for IPv4 and IPv6, including IPv6 forms that
 * embed an IPv4 address. A string that is not an IP address counts as not
 * public.
 */
export function isNonPublicAddress(address: string): boolean {
  return matches(blockList, address);
}

/**
 * Whether an IP address is one no outbound request should reach even on a
 * private network: unspecified, link-local (cloud metadata), multicast or
 * reserved, including IPv6 forms that embed such an IPv4 address. Loopback and
 * private ranges are not in this set. A string that is not an IP address
 * counts as unroutable.
 */
export function isUnroutableAddress(address: string): boolean {
  return matches(unroutableList, address);
}

function matches(list: BlockList, address: string): boolean {
  const family = isIP(address);
  if (family === 4) return list.check(address, 'ipv4');
  if (family !== 6) return true;
  const withoutZone = address.split('%')[0] ?? address;
  if (list.check(withoutZone, 'ipv6')) return true;
  const v4 = embeddedIpv4(ipv6Groups(withoutZone));
  return v4 != null && list.check(v4, 'ipv4');
}

/** Thrown when a host is, or resolves to, an address the guard does not allow. */
export class BlockedDestinationError extends Error {
  readonly code = 'BLOCKED_DESTINATION';

  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(`Blocked outbound request to ${host}: ${address} is not an allowed address`);
    this.name = 'BlockedDestinationError';
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** Which destinations a guarded request may reach. */
export interface GuardOptions {
  /** Hosts (names or IP addresses, case-insensitive) that skip the address check. */
  allowedPrivateHosts?: readonly string[];
  /**
   * Allow loopback and private addresses (a trusted private peering). Only
   * unroutable addresses (isUnroutableAddress) are refused then.
   */
  allowPrivateNetworks?: boolean;
}

function guardOf(options: GuardOptions): {
  allowed: Set<string>;
  isBlocked: (address: string) => boolean;
} {
  return {
    allowed: new Set((options.allowedPrivateHosts ?? []).map(normalizeHost)),
    isBlocked: options.allowPrivateNetworks === true ? isUnroutableAddress : isNonPublicAddress,
  };
}

/**
 * A `lookup` for net.connect and tls.connect that resolves every A and AAAA
 * record and fails with BlockedDestinationError when any of them is blocked
 * (not public, or with `allowPrivateNetworks` unroutable), unless the host is
 * in `allowedPrivateHosts`. The socket connects to an address this lookup
 * returned, so the check and the connect see the same answer.
 */
export function createGuardedLookup(options: GuardOptions = {}) {
  const { allowed, isBlocked } = guardOf(options);
  return (
    hostname: string,
    lookupOptions: LookupOneOptions | LookupAllOptions | number,
    callback: LookupCallback,
  ): void => {
    const opts = typeof lookupOptions === 'number' ? { family: lookupOptions } : lookupOptions;
    const host = normalizeHost(hostname);
    dns.lookup(host, { all: true, family: opts.family ?? 0 }, (err, records) => {
      if (err != null) {
        callback(err, []);
        return;
      }
      if (records.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error(`No address for ${host}`);
        notFound.code = 'ENOTFOUND';
        callback(notFound, []);
        return;
      }
      if (!allowed.has(host)) {
        const blocked = records.find((r) => isBlocked(r.address));
        if (blocked != null) {
          callback(new BlockedDestinationError(host, blocked.address), []);
          return;
        }
      }
      if (opts.all === true) {
        callback(null, records);
        return;
      }
      const [first] = records as [LookupAddress];
      callback(null, first.address, first.family);
    });
  };
}

/**
 * An undici Agent whose every connection goes through the guard: an IP literal
 * host is checked directly (no DNS lookup happens for it), a name through
 * createGuardedLookup.
 */
export function createGuardedAgent(options: GuardOptions = {}): Agent {
  const { allowed, isBlocked } = guardOf(options);
  const connector = buildConnector({ lookup: createGuardedLookup(options) });
  return new Agent({
    connect: (opts, callback) => {
      const host = normalizeHost(opts.hostname);
      if (isIP(host) !== 0 && !allowed.has(host) && isBlocked(host)) {
        callback(new BlockedDestinationError(host, host), null);
        return;
      }
      connector(opts, callback);
    },
  });
}

// One agent per guard configuration, so connections are pooled across
// requests. Allowlists change rarely; the cap only bounds a misuse.
const agents = new Map<string, Agent>();
const MAX_AGENTS = 16;

function agentFor(options: GuardOptions): Agent {
  const hosts = [...new Set((options.allowedPrivateHosts ?? []).map(normalizeHost))].sort();
  const key = `${options.allowPrivateNetworks === true ? 'private' : 'public'}|${hosts.join(',')}`;
  let agent = agents.get(key);
  if (agent == null) {
    if (agents.size >= MAX_AGENTS) {
      for (const old of agents.values()) void old.close();
      agents.clear();
    }
    agent = createGuardedAgent(options);
    agents.set(key, agent);
  }
  return agent;
}

export interface SafeFetchInit extends Omit<RequestInit, 'dispatcher'>, GuardOptions {}

/** The undici Response that safeFetch returns. */
export type SafeFetchResponse = Response;

/**
 * fetch for a URL the CSMS does not control. Only http and https. Rejects
 * with BlockedDestinationError (directly or as the `cause` of the fetch
 * TypeError) when the host is, or resolves to, a blocked address and is not
 * in `allowedPrivateHosts`. Blocked means not public, or with
 * `allowPrivateNetworks` unroutable (isUnroutableAddress).
 */
export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedDestinationError(parsed.hostname, parsed.protocol);
  }
  const { allowedPrivateHosts, allowPrivateNetworks, ...rest } = init;
  const guard: GuardOptions = {};
  if (allowedPrivateHosts != null) guard.allowedPrivateHosts = allowedPrivateHosts;
  if (allowPrivateNetworks != null) guard.allowPrivateNetworks = allowPrivateNetworks;
  return undiciFetch(url, { ...rest, dispatcher: agentFor(guard) });
}

/** The BlockedDestinationError behind a safeFetch failure, if that is the cause. */
export function blockedDestinationOf(err: unknown): BlockedDestinationError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof BlockedDestinationError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
