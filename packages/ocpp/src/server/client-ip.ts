// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

function normalize(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export function parseTrustedProxies(setting: string): BlockList | null {
  const entries = setting
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefixText] = entry.split('/');
    const family = isIP(address);
    if (family === 0) throw new Error(`Invalid trusted proxy address: ${entry}`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

// TLS usually ends at a load balancer, so the socket here is plain. A trusted proxy
// reports the client's scheme in X-Forwarded-Proto. The last value is the one the
// nearest proxy set; values further left can be forged by the client.
export function isTlsConnection(req: IncomingMessage, trusted: BlockList | null): boolean {
  if ('encrypted' in req.socket && req.socket.encrypted === true) return true;
  const socketAddress = req.socket.remoteAddress;
  if (trusted == null || socketAddress == null || !isTrusted(trusted, normalize(socketAddress))) {
    return false;
  }
  const header = req.headers['x-forwarded-proto'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const last = raw.split(',').at(-1)?.trim().toLowerCase();
  return last === 'https' || last === 'wss';
}

// Behind a trusted proxy, the client is the rightmost X-Forwarded-For hop that is not
// itself a trusted proxy; anything further left can be forged by the client.
export function resolveClientIp(req: IncomingMessage, trusted: BlockList | null): string | null {
  const socketAddress = req.socket.remoteAddress;
  if (socketAddress == null) return null;
  const peer = normalize(socketAddress);
  if (trusted == null || !isTrusted(trusted, peer)) return peer;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const hops = raw
    .split(',')
    .map((hop) => normalize(hop.trim()))
    .filter((hop) => isIP(hop) !== 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop !== undefined && !isTrusted(trusted, hop)) return hop;
  }
  return peer;
}
