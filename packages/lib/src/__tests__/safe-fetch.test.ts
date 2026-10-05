// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';

// Mock DNS: each name maps to a queue of answers; the last answer repeats.
const answers = new Map<string, LookupAddress[][]>();
const lookupCalls: string[] = [];

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = (
    hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, records: LookupAddress[]) => void,
  ): void => {
    lookupCalls.push(hostname);
    const queue = answers.get(hostname);
    if (queue == null || queue.length === 0) {
      const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      setImmediate(() => {
        callback(err, []);
      });
      return;
    }
    const records = queue.length > 1 ? (queue.shift() ?? []) : (queue[0] ?? []);
    setImmediate(() => {
      callback(null, records);
    });
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const {
  isNonPublicAddress,
  isUnroutableAddress,
  createGuardedLookup,
  safeFetch,
  blockedDestinationOf,
  BlockedDestinationError,
} = await import('../safe-fetch.js');

function v4(address: string): LookupAddress {
  return { address, family: 4 };
}
function v6(address: string): LookupAddress {
  return { address, family: 6 };
}

function resolveTo(name: string, ...queue: LookupAddress[][]): void {
  answers.set(name, queue);
}

function guardedLookup(
  hostname: string,
  allowlist: string[] = [],
  all = true,
  allowPrivateNetworks = false,
): Promise<LookupAddress[] | string> {
  return new Promise((resolve, reject) => {
    createGuardedLookup({ allowedPrivateHosts: allowlist, allowPrivateNetworks })(
      hostname,
      { all },
      (err, address) => {
        if (err != null) reject(err);
        else resolve(address);
      },
    );
  });
}

let server: http.Server;
let port: number;
let hits: string[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/target` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  answers.clear();
  lookupCalls.length = 0;
  hits = [];
});

describe('isNonPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
  ])('blocks IPv4 %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.32.0.1', '192.169.0.1'])(
    'allows public IPv4 %s',
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    },
  );

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['febf::1', 'link-local upper bound'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback, dotted'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata address'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::192.168.1.1', 'IPv4-compatible private'],
    ['::5', 'IPv4-compatible block'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['2002:c0a8:101::1', '6to4 private'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    '2001:4860:4860::8888',
    '2607:f8b0:4005:80a::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows public IPv6 %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });

  it('treats a string that is not an IP address as not public', () => {
    expect(isNonPublicAddress('example.com')).toBe(true);
    expect(isNonPublicAddress('')).toBe(true);
  });
});

describe('isUnroutableAddress', () => {
  it.each([
    '0.0.0.0',
    '169.254.169.254',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    'fe80::1',
    'ff02::1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
  ])('flags %s', (address) => {
    expect(isUnroutableAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.18.0.3',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    '8.8.8.8',
  ])('does not flag loopback, private or public %s', (address) => {
    expect(isUnroutableAddress(address)).toBe(false);
  });
});

describe('createGuardedLookup', () => {
  it('returns every record of a public name', async () => {
    resolveTo('ocsp.example.com', [v4('8.8.8.8'), v6('2001:4860:4860::8888')]);
    await expect(guardedLookup('ocsp.example.com')).resolves.toEqual([
      v4('8.8.8.8'),
      v6('2001:4860:4860::8888'),
    ]);
    await expect(guardedLookup('ocsp.example.com', [], false)).resolves.toBe('8.8.8.8');
  });

  it('blocks a name that resolves to a private address', async () => {
    resolveTo('intranet.example.com', [v4('10.0.0.5')]);
    await expect(guardedLookup('intranet.example.com')).rejects.toBeInstanceOf(
      BlockedDestinationError,
    );
  });

  it('blocks when any record is private (mixed A records)', async () => {
    resolveTo('mixed.example.com', [v4('8.8.8.8'), v4('127.0.0.1')]);
    await expect(guardedLookup('mixed.example.com')).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('blocks when the AAAA record is private and the A record is public', async () => {
    resolveTo('mixed6.example.com', [v4('8.8.8.8'), v6('::ffff:169.254.169.254')]);
    await expect(guardedLookup('mixed6.example.com')).rejects.toBeInstanceOf(
      BlockedDestinationError,
    );
  });

  it.each([['fd00::1'], ['fe80::1'], ['::1'], ['::ffff:7f00:1']])(
    'blocks a name whose AAAA record is %s',
    async (address) => {
      resolveTo('v6.example.com', [v6(address)]);
      await expect(guardedLookup('v6.example.com')).rejects.toBeInstanceOf(BlockedDestinationError);
    },
  );

  it('lets an allowlisted host resolve to a private address, case-insensitively', async () => {
    resolveTo('host.docker.internal', [v4('192.168.65.254')]);
    await expect(guardedLookup('HOST.docker.internal', ['host.docker.internal'])).resolves.toEqual([
      v4('192.168.65.254'),
    ]);
  });

  it('passes resolution errors through', async () => {
    await expect(guardedLookup('missing.example.com')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });
});

describe('createGuardedLookup with allowPrivateNetworks', () => {
  it('lets a name resolve to loopback and private addresses', async () => {
    resolveTo('ocpi-simulator', [v4('172.18.0.7'), v6('fd00::7')]);
    await expect(guardedLookup('ocpi-simulator', [], true, true)).resolves.toEqual([
      v4('172.18.0.7'),
      v6('fd00::7'),
    ]);
  });

  it('still blocks the cloud metadata address and other unroutable records', async () => {
    resolveTo('metadata.attacker.example', [v4('10.0.0.1'), v4('169.254.169.254')]);
    await expect(guardedLookup('metadata.attacker.example', [], true, true)).rejects.toBeInstanceOf(
      BlockedDestinationError,
    );
  });
});

describe('safeFetch', () => {
  it('rejects a private IP literal without connecting', async () => {
    const err = await safeFetch(`http://127.0.0.1:${String(port)}/`).catch((e: unknown) => e);
    expect(blockedDestinationOf(err)).toBeInstanceOf(BlockedDestinationError);
    expect(hits).toEqual([]);
  });

  it.each([['[::1]'], ['[::ffff:127.0.0.1]']])(
    'rejects the IPv6 literal %s without connecting',
    async (host) => {
      const err = await safeFetch(`http://${host}:${String(port)}/`).catch((e: unknown) => e);
      expect(blockedDestinationOf(err)).not.toBeNull();
      expect(hits).toEqual([]);
    },
  );

  it('rejects a public-looking name that resolves to a private address', async () => {
    resolveTo('ocsp.attacker.example', [v4('127.0.0.1')]);
    const err = await safeFetch(`http://ocsp.attacker.example:${String(port)}/`).catch(
      (e: unknown) => e,
    );
    expect(blockedDestinationOf(err)?.address).toBe('127.0.0.1');
    expect(hits).toEqual([]);
  });

  it('rejects a DNS rebinding: public when checked first, private at connect', async () => {
    // The first answer is public, every later answer private. A separate
    // check-then-connect would see the public answer and then connect to the
    // private one. The guard checks the answer the socket connects with.
    resolveTo('rebind.attacker.example', [v4('8.8.8.8')], [v4('127.0.0.1')]);
    await expect(guardedLookup('rebind.attacker.example')).resolves.toEqual([v4('8.8.8.8')]);
    const err = await safeFetch(`http://rebind.attacker.example:${String(port)}/`).catch(
      (e: unknown) => e,
    );
    expect(blockedDestinationOf(err)?.address).toBe('127.0.0.1');
    expect(hits).toEqual([]);
  });

  it('connects an allowlisted host to the address the guarded lookup returned', async () => {
    resolveTo('ocsp-responder.test', [v4('127.0.0.1')]);
    const res = await safeFetch(`http://ocsp-responder.test:${String(port)}/ocsp`, {
      allowedPrivateHosts: ['ocsp-responder.test'],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(hits).toEqual(['/ocsp']);
    expect(lookupCalls).toContain('ocsp-responder.test');
  });

  it('lets an allowlisted IP literal through', async () => {
    const res = await safeFetch(`http://127.0.0.1:${String(port)}/literal`, {
      allowedPrivateHosts: ['127.0.0.1'],
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it('checks a redirect target like the first request', async () => {
    resolveTo('redirector.test', [v4('127.0.0.1')]);
    const err = await safeFetch(`http://redirector.test:${String(port)}/redirect`, {
      allowedPrivateHosts: ['redirector.test'],
    }).catch((e: unknown) => e);
    expect(blockedDestinationOf(err)?.host).toBe('127.0.0.1');
    expect(hits).toEqual(['/redirect']);
  });

  it('reaches a private address with allowPrivateNetworks', async () => {
    resolveTo('peer.private.test', [v4('127.0.0.1')]);
    const res = await safeFetch(`http://peer.private.test:${String(port)}/peer`, {
      allowPrivateNetworks: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(hits).toEqual(['/peer']);
  });

  it('rejects a link-local literal even with allowPrivateNetworks', async () => {
    const err = await safeFetch('http://169.254.169.254/latest/meta-data/', {
      allowPrivateNetworks: true,
    }).catch((e: unknown) => e);
    expect(blockedDestinationOf(err)?.address).toBe('169.254.169.254');
  });

  it('rejects non-http schemes', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedDestinationError);
  });
});
