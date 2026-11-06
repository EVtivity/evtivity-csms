// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import dns from 'node:dns';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { BlockedDestinationError } from '@evtivity/lib';
import {
  createStorageRequestHandler,
  parseStorageAllowedPrivateHosts,
  r2EndpointBucket,
  validateR2Endpoint,
  validateStorageEndpoint,
} from '../storage/index.js';

// Link-local and cloud metadata, the EC2 IPv6 metadata address, unspecified,
// multicast and an IPv4-mapped metadata address (security review case 278).
const UNROUTABLE_HOSTS = [
  '169.254.169.254',
  'fd00:ec2::254',
  'fe80::1',
  '0.0.0.0',
  '224.0.0.1',
  '::ffff:169.254.169.254',
];

type HttpRequest = Parameters<NodeHttpHandler['handle']>[0];

describe('validateStorageEndpoint', () => {
  it('keeps the origin of a public https endpoint', () => {
    expect(validateStorageEndpoint('https://s3.wasabisys.com', [])).toBe(
      'https://s3.wasabisys.com',
    );
    expect(validateStorageEndpoint(' https://storage.example.com:9000/ ', [])).toBe(
      'https://storage.example.com:9000',
    );
  });

  it('refuses a value that is not an http(s) URL', () => {
    for (const value of [undefined, null, 42, '', 'storage.example.com', 'ftp://example.com']) {
      expect(validateStorageEndpoint(value, []), String(value)).toBeNull();
    }
  });

  it('refuses credentials, a path, a query or a fragment', () => {
    for (const value of [
      'https://user:pass@storage.example.com',
      'https://storage.example.com/bucket',
      'https://storage.example.com/?a=1',
      'https://storage.example.com/#x',
    ]) {
      expect(validateStorageEndpoint(value, []), value).toBeNull();
    }
  });

  it('refuses plain http to a public host', () => {
    expect(validateStorageEndpoint('http://storage.example.com', [])).toBeNull();
  });

  it('refuses a private or internal host', () => {
    for (const value of [
      'https://localhost:9000',
      'https://minio.local',
      'https://minio.internal',
      'https://127.0.0.1',
      'https://10.0.0.5:9000',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:192.168.1.10]',
    ]) {
      expect(validateStorageEndpoint(value, []), value).toBeNull();
    }
  });

  it('accepts a private host on the allowlist, over http or https', () => {
    expect(validateStorageEndpoint('http://minio.internal:9000', ['minio.internal'])).toBe(
      'http://minio.internal:9000',
    );
    expect(validateStorageEndpoint('https://10.0.0.5:9000', ['10.0.0.5'])).toBe(
      'https://10.0.0.5:9000',
    );
    expect(validateStorageEndpoint('http://[::1]:9000', ['::1'])).toBe('http://[::1]:9000');
  });

  it('allows only the hosts on the allowlist', () => {
    expect(validateStorageEndpoint('http://other.internal:9000', ['minio.internal'])).toBeNull();
  });

  it('refuses a link-local or cloud metadata address even when it is on the allowlist', () => {
    for (const host of UNROUTABLE_HOSTS) {
      const literal = host.includes(':') ? `[${host}]` : host;
      for (const scheme of ['http', 'https']) {
        expect(validateStorageEndpoint(`${scheme}://${literal}`, [host]), host).toBeNull();
      }
    }
  });
});

describe('validateR2Endpoint', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

  it.each([
    [ORIGIN, ORIGIN],
    [`${ORIGIN}/`, ORIGIN],
    [`  https://${ACCOUNT}.R2.CloudflareStorage.com  `, ORIGIN],
    [
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    ],
    [
      `https://${ACCOUNT}.fedramp.r2.cloudflarestorage.com`,
      `https://${ACCOUNT}.fedramp.r2.cloudflarestorage.com`,
    ],
    [
      `https://${ACCOUNT}.us.r2.cloudflarestorage.com`,
      `https://${ACCOUNT}.us.r2.cloudflarestorage.com`,
    ],
    [
      `https://${ACCOUNT}.us.r2.cloudflarestorage.com/my-bucket`,
      `https://${ACCOUNT}.us.r2.cloudflarestorage.com`,
    ],
    // The S3 API URL Cloudflare shows on a bucket ends in the bucket name.
    [`${ORIGIN}/my-bucket`, ORIGIN],
    [`${ORIGIN}/my-bucket/`, ORIGIN],
    // A trailing dot of the host is dropped, so the stored origin matches the
    // signed Host and the STORAGE_IMG_SRC origin.
    [`https://${ACCOUNT}.r2.cloudflarestorage.com.`, ORIGIN],
    [`https://${ACCOUNT}.r2.cloudflarestorage.com./my-bucket`, ORIGIN],
    [
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com.`,
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    ],
  ])('accepts %s', (value, origin) => {
    expect(validateR2Endpoint(value)).toBe(origin);
  });

  it.each([
    undefined,
    42,
    '',
    'not a url',
    // Not https, a port, or credentials.
    `http://${ACCOUNT}.r2.cloudflarestorage.com`,
    `${ORIGIN}:8443`,
    `https://user:pass@${ACCOUNT}.r2.cloudflarestorage.com`,
    // A query, a fragment, a deeper path or a bucket name R2 does not allow.
    `${ORIGIN}/?x=1`,
    `${ORIGIN}/#x`,
    `${ORIGIN}/my-bucket/key`,
    `${ORIGIN}/My_Bucket`,
    // Not an account's S3 API host: presigned URLs work only there.
    'https://r2.cloudflarestorage.com',
    'https://abc.r2.cloudflarestorage.com',
    `https://${ACCOUNT}0.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.asia.r2.cloudflarestorage.com`,
    `https://x.${ACCOUNT}.r2.cloudflarestorage.com`,
    `${ORIGIN}.evil.example`,
    'https://pub-0123456789abcdef0123456789abcdef.r2.dev',
    'https://files.example.com',
    'https://10.0.0.5',
    'https://169.254.169.254',
  ])('refuses %s', (value) => {
    expect(validateR2Endpoint(value)).toBeNull();
  });

  // Addresses close to an account S3 API host (case 364): a near jurisdiction label,
  // two jurisdictions, an extra or missing label, a port, an IDN label, a look-alike
  // registrable domain or a host hidden behind userinfo.
  it.each([
    `https://${ACCOUNT}.usa.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us-east.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.eur.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.fed.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.eu.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.eu.us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}..r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us..r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com:443x`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com:8443`,
    `https://${ACCOUNT}.eu.r2.cloudflarestorage.com:444`,
    `https://${ACCOUNT}.xn--us-6ka.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.xn--r2-dka.cloudflarestorage.com`,
    `https://${ACCOUNT}.r2.xn--cloudflarestorage-o0b.com`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com.evil.example`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com.us`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.co`,
    `https://${ACCOUNT}.us.r2-cloudflarestorage.com`,
    `https://${ACCOUNT}.us.r2.cloudflare-storage.com`,
    `https://${ACCOUNT}.us.r3.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.cloudflarestorage.com`,
    `https://${ACCOUNT}us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT.slice(1)}.us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT.slice(1)}g.us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com@evil.example`,
    `https://${ACCOUNT}.US.r2.cloudflarestorage.com@evil.example`,
    `https://evil.example\\@${ACCOUNT}.us.r2.cloudflarestorage.com`,
    `https://evil.example#@${ACCOUNT}.us.r2.cloudflarestorage.com`,
    `https://evil.example/${ACCOUNT}.us.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com%2Fevil.example`,
    `wss://${ACCOUNT}.us.r2.cloudflarestorage.com`,
    `//${ACCOUNT}.us.r2.cloudflarestorage.com`,
    `${ACCOUNT}.us.r2.cloudflarestorage.com`,
  ])('refuses the look-alike %s', (value) => {
    expect(validateR2Endpoint(value)).toBeNull();
  });

  // Spellings a URL parser reads as the same host: accepted and stored in the one
  // lower-case form, so the stored origin never differs from the signed Host.
  it.each([
    `https://${ACCOUNT.toUpperCase()}.US.R2.CLOUDFLARESTORAGE.COM`,
    `https://${ACCOUNT}.Us.R2.cloudflarestorage.com`,
    `https://${ACCOUNT}.us.r2.cloudflarestorage.com:443`,
    `https://${ACCOUNT}.\uff55\uff53.r2.cloudflarestorage.com`,
    `https://${ACCOUNT}%2Eus.r2.cloudflarestorage.com`,
  ])('stores %s as the lower-case origin', (value) => {
    expect(validateR2Endpoint(value)).toBe(`https://${ACCOUNT}.us.r2.cloudflarestorage.com`);
  });
});

describe('r2EndpointBucket', () => {
  const ORIGIN = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

  it.each([
    [`${ORIGIN}/my-bucket`, 'my-bucket'],
    [`${ORIGIN}/my-bucket/`, 'my-bucket'],
    [` ${ORIGIN}/my-bucket `, 'my-bucket'],
    [ORIGIN, null],
    [`${ORIGIN}/`, null],
    // Not a valid R2 endpoint: no bucket is read from it.
    ['https://files.example.com/my-bucket', null],
    [`${ORIGIN}/my-bucket/key`, null],
    [undefined, null],
  ])('reads %s as %s', (value, bucket) => {
    expect(r2EndpointBucket(value)).toBe(bucket);
  });
});

describe('parseStorageAllowedPrivateHosts', () => {
  it('keeps hostnames and private IP addresses, trimmed and lowercased', () => {
    expect(parseStorageAllowedPrivateHosts([' MinIO.Internal ', '10.0.0.5', '::1'])).toEqual([
      'minio.internal',
      '10.0.0.5',
      '::1',
    ]);
    expect(parseStorageAllowedPrivateHosts([])).toEqual([]);
  });

  it('refuses a list with a link-local or cloud metadata address', () => {
    for (const host of UNROUTABLE_HOSTS) {
      expect(parseStorageAllowedPrivateHosts(['minio.internal', host]), host).toBeNull();
    }
  });

  it('refuses what parseAllowedPrivateHosts refuses', () => {
    for (const value of ['minio.internal', [42], ['http://minio.internal'], ['minio:9000']]) {
      expect(parseStorageAllowedPrivateHosts(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('createStorageRequestHandler', () => {
  const server = createServer((_req, res) => {
    res.end('ok');
  });
  let port = 0;

  beforeAll(async () => {
    // Every interface, so `localhost` connects whether it resolves to 127.0.0.1 or ::1.
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(hostname: string): HttpRequest {
    return {
      protocol: 'http:',
      hostname,
      port,
      method: 'GET',
      path: '/',
      query: {},
      headers: { host: `${hostname}:${String(port)}` },
    } as unknown as HttpRequest;
  }

  it('refuses a host that resolves to a private address', async () => {
    const handler = createStorageRequestHandler('my-bucket', []);
    await expect(handler.handle(get('localhost'))).rejects.toBeInstanceOf(BlockedDestinationError);
    handler.destroy();
  });

  it('refuses a private IP address host, which Node connects to without a lookup', async () => {
    const handler = createStorageRequestHandler('my-bucket', []);
    await expect(handler.handle(get('127.0.0.1'))).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(handler.handle(get('[::1]'))).rejects.toBeInstanceOf(BlockedDestinationError);
    handler.destroy();
  });

  it('connects to a private IP address on the allowlist', async () => {
    const handler = createStorageRequestHandler('my-bucket', ['127.0.0.1']);
    const { response } = await handler.handle(get('127.0.0.1'));
    expect(response.statusCode).toBe(200);
    handler.destroy();
  });

  it('connects to a private host on the allowlist', async () => {
    const handler = createStorageRequestHandler('my-bucket', ['localhost']);
    const { response } = await handler.handle(get('localhost'));
    expect(response.statusCode).toBe(200);
    handler.destroy();
  });

  it('connects to the virtual-hosted bucket name of an allowed host', async () => {
    const handler = createStorageRequestHandler('my-bucket', ['localhost']);
    const lookup = vi.spyOn(dns, 'lookup');
    lookup.mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (err: null, records: dns.LookupAddress[]) => void,
    ) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as unknown as typeof dns.lookup);
    const { response } = await handler.handle(get('my-bucket.localhost'));
    expect(response.statusCode).toBe(200);
    handler.destroy();
    lookup.mockRestore();
  });

  describe('unroutable addresses (security review case 278)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refuses a cloud metadata IP address even when it is on the allowlist', async () => {
      for (const host of UNROUTABLE_HOSTS) {
        const handler = createStorageRequestHandler('my-bucket', [host]);
        const literal = host.includes(':') ? `[${host}]` : host;
        await expect(handler.handle(get(literal)), host).rejects.toBeInstanceOf(
          BlockedDestinationError,
        );
        handler.destroy();
      }
    });

    it('refuses an allowed name that resolves to a cloud metadata address', async () => {
      const lookup = vi.spyOn(dns, 'lookup');
      lookup.mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (err: null, records: dns.LookupAddress[]) => void,
      ) => {
        callback(null, [
          { address: '10.0.0.5', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]);
      }) as unknown as typeof dns.lookup);
      const handler = createStorageRequestHandler('my-bucket', ['minio.internal']);
      await expect(handler.handle(get('minio.internal'))).rejects.toBeInstanceOf(
        BlockedDestinationError,
      );
      await expect(handler.handle(get('my-bucket.minio.internal'))).rejects.toBeInstanceOf(
        BlockedDestinationError,
      );
      handler.destroy();
    });

    it('refuses a name off the allowlist that resolves to a private address', async () => {
      const lookup = vi.spyOn(dns, 'lookup');
      lookup.mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (err: null, records: dns.LookupAddress[]) => void,
      ) => {
        callback(null, [{ address: '10.0.0.5', family: 4 }]);
      }) as unknown as typeof dns.lookup);
      const handler = createStorageRequestHandler('my-bucket', ['minio.internal']);
      await expect(handler.handle(get('other.internal'))).rejects.toBeInstanceOf(
        BlockedDestinationError,
      );
      handler.destroy();
    });
  });
});
