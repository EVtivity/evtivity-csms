// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { BlockedDestinationError } from '@evtivity/lib';
import { createStorageRequestHandler, validateStorageEndpoint } from '../storage/index.js';

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
});
