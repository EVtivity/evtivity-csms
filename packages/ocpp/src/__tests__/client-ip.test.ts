// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientAddressKey } from '@evtivity/lib/ip-address';
import {
  isTlsConnection,
  parseTrustedProxies,
  resolveClientIp,
  stationEndpointUrl,
} from '../server/client-ip.js';

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

  // Number() read these prefixes as 0,
  // a trust-all subnet that let a forged X-Forwarded-Proto pass profile 2 over ws.
  it.each(['10.0.0.0/', '10.0.0.0/0x0', '10.0.0.0/0.0', '10.0.0.0/ 0', '::/-0', '10.0.0.0/8/1'])(
    'refuses the malformed prefix %s',
    (entry) => {
      expect(() => parseTrustedProxies(entry)).toThrow();
    },
  );

  it('refuses a /0 entry, which trusts every peer', () => {
    expect(() => parseTrustedProxies('0.0.0.0/0')).toThrow();
    expect(() => parseTrustedProxies('10.0.0.0/8, ::/00')).toThrow();
  });
});

describe('isTlsConnection', () => {
  const trusted = parseTrustedProxies('10.10.0.0/16');
  const make = (
    remoteAddress: string,
    proto?: string | string[],
    encrypted = false,
  ): IncomingMessage =>
    ({
      socket: encrypted ? { remoteAddress, encrypted: true } : { remoteAddress },
      headers: proto === undefined ? {} : { 'x-forwarded-proto': proto },
    }) as unknown as IncomingMessage;

  it('accepts TLS on the socket itself', () => {
    expect(isTlsConnection(make('203.0.113.5', undefined, true), null)).toBe(true);
  });

  it('accepts https reported by a trusted load balancer', () => {
    expect(isTlsConnection(make('10.10.3.4', 'https'), trusted)).toBe(true);
    expect(isTlsConnection(make('::ffff:10.10.3.4', 'wss'), trusted)).toBe(true);
  });

  it('ignores the header from an untrusted peer', () => {
    expect(isTlsConnection(make('203.0.113.5', 'https'), trusted)).toBe(false);
  });

  it('ignores the header when no proxies are trusted', () => {
    expect(isTlsConnection(make('10.10.3.4', 'https'), null)).toBe(false);
  });

  it('uses the value the nearest proxy set, so a client cannot prepend https', () => {
    expect(isTlsConnection(make('10.10.3.4', 'https, http'), trusted)).toBe(false);
    expect(isTlsConnection(make('10.10.3.4', 'http, https'), trusted)).toBe(true);
  });

  it('treats a plain or missing scheme as not TLS', () => {
    expect(isTlsConnection(make('10.10.3.4', 'http'), trusted)).toBe(false);
    expect(isTlsConnection(make('10.10.3.4'), trusted)).toBe(false);
  });
});

describe('stationEndpointUrl', () => {
  const withHost = (host?: string): IncomingMessage =>
    ({ headers: host === undefined ? {} : { host } }) as unknown as IncomingMessage;

  it('is the scheme and the Host header, without the station id path', () => {
    expect(stationEndpointUrl(withHost('csms.example.com:7103'), false)).toBe(
      'ws://csms.example.com:7103',
    );
    expect(stationEndpointUrl(withHost('ocpp.example.com'), true)).toBe('wss://ocpp.example.com');
    expect(stationEndpointUrl(withHost('[::1]:8443'), true)).toBe('wss://[::1]:8443');
  });

  it('is null without a usable Host header', () => {
    expect(stationEndpointUrl(withHost(), false)).toBeNull();
    expect(stationEndpointUrl(withHost(''), false)).toBeNull();
    expect(stationEndpointUrl(withHost('user:pw@host'), false)).toBeNull();
    expect(stationEndpointUrl(withHost('host/path'), false)).toBeNull();
    expect(stationEndpointUrl(withHost('host?x=1'), false)).toBeNull();
    expect(stationEndpointUrl(withHost('a b'), false)).toBeNull();
    expect(stationEndpointUrl(withHost(`${'h'.repeat(256)}.com`), false)).toBeNull();
  });
});

describe('clientAddressKey', () => {
  it('keeps an IPv4 address and keys IPv6 on its /64', () => {
    expect(clientAddressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:0db8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientAddressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientAddressKey('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressKey('unknown')).toBe('unknown');
  });

  // The pending-auth cap and the wrong-password lockout key on
  // clientAddressKey(resolveClientIp(...)): a hex-mapped IPv4 peer must land on
  // its IPv4 key, never on the shared ::ffff:0:0/64 bucket.
  it('keys a hex-mapped IPv4 peer like its dotted and plain forms', () => {
    const hex = resolveClientIp(req('::ffff:cb00:7107'), null);
    expect(hex).toBe('203.0.113.7');
    expect(clientAddressKey(hex ?? '')).toBe('203.0.113.7');
    expect(clientAddressKey('::ffff:cb00:7107')).toBe(clientAddressKey('::ffff:203.0.113.7'));
    expect(clientAddressKey('::ffff:cb00:7107')).not.toBe(clientAddressKey('::ffff:cb00:7108'));
  });

  it('treats a hex-mapped trusted proxy as its IPv4 address', () => {
    const trusted = parseTrustedProxies('10.10.0.0/16');
    expect(resolveClientIp(req('::ffff:a0a:114', '198.51.100.7'), trusted)).toBe('198.51.100.7');
    expect(resolveClientIp(req('10.10.1.20', '::ffff:c633:6407'), trusted)).toBe('198.51.100.7');
  });
});
