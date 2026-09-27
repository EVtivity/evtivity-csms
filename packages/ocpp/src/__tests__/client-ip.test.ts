// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { parseTrustedProxies, resolveClientIp } from '../server/client-ip.js';

function req(remoteAddress: string | undefined, xff?: string | string[]): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as IncomingMessage;
}

describe('resolveClientIp', () => {
  const trusted = parseTrustedProxies('10.10.0.0/16');

  it('uses the socket address when no proxies are trusted', () => {
    expect(resolveClientIp(req('203.0.113.9', '198.51.100.7'), null)).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(resolveClientIp(req('203.0.113.9', '198.51.100.7'), trusted)).toBe('203.0.113.9');
  });

  it('uses the forwarded client address when the peer is a trusted proxy', () => {
    expect(resolveClientIp(req('10.10.1.20', '198.51.100.7'), trusted)).toBe('198.51.100.7');
  });

  it('takes the rightmost untrusted hop so a client cannot spoof the header', () => {
    expect(resolveClientIp(req('10.10.1.20', '1.2.3.4, 198.51.100.7'), trusted)).toBe(
      '198.51.100.7',
    );
  });

  it('skips trusted hops at the end of the chain', () => {
    expect(resolveClientIp(req('10.10.1.20', '198.51.100.7, 10.10.2.3'), trusted)).toBe(
      '198.51.100.7',
    );
  });

  it('normalizes IPv4-mapped IPv6 socket addresses', () => {
    expect(resolveClientIp(req('::ffff:10.10.1.20', '198.51.100.7'), trusted)).toBe('198.51.100.7');
  });

  it('falls back to the socket address when the header is missing or invalid', () => {
    expect(resolveClientIp(req('10.10.1.20'), trusted)).toBe('10.10.1.20');
    expect(resolveClientIp(req('10.10.1.20', 'not-an-ip'), trusted)).toBe('10.10.1.20');
  });

  it('returns null when the socket address is unknown', () => {
    expect(resolveClientIp(req(undefined), trusted)).toBeNull();
  });
});

describe('parseTrustedProxies', () => {
  it('returns null for an empty setting', () => {
    expect(parseTrustedProxies('')).toBeNull();
    expect(parseTrustedProxies('  ')).toBeNull();
  });

  it('accepts a comma-separated list of CIDRs and single addresses', () => {
    const list = parseTrustedProxies('10.0.0.0/8, 192.168.1.5, fd00::/8');
    expect(list?.check('10.1.2.3')).toBe(true);
    expect(list?.check('192.168.1.5')).toBe(true);
    expect(list?.check('fd00::1', 'ipv6')).toBe(true);
    expect(list?.check('8.8.8.8')).toBe(false);
  });

  it('rejects an invalid entry', () => {
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow();
    expect(() => parseTrustedProxies('nonsense')).toThrow();
  });
});
