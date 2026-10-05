// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ctorCalls } = vi.hoisted(() => ({ ctorCalls: [] as unknown[][] }));

vi.mock('ioredis', () => {
  class MockRedis {
    on = vi.fn();
    constructor(...args: unknown[]) {
      ctorCalls.push(args);
    }
  }
  return { Redis: MockRedis, default: MockRedis };
});

const { redisTlsOptions, createRedisClient } = await import('../redis-client.js');

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('redisTlsOptions', () => {
  it('adds nothing for a plain URL without a CA', () => {
    expect(redisTlsOptions('redis://api:pw@redis:6379', {})).toEqual({});
  });

  it('uses the system CAs for rediss:// without a CA (ElastiCache)', () => {
    expect(redisTlsOptions('rediss://api:pw@cache:6379', {})).toEqual({});
  });

  it('trusts the CA from REDIS_TLS_CA_PEM for rediss://', () => {
    expect(redisTlsOptions('rediss://api:pw@redis:6379', { REDIS_TLS_CA_PEM: PEM })).toEqual({
      tls: { ca: PEM },
    });
  });

  it('reads the CA from REDIS_TLS_CA_FILE for rediss://', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'redis-ca-')), 'ca.crt');
    writeFileSync(file, PEM);
    expect(redisTlsOptions('REDISS://api:pw@redis:6379', { REDIS_TLS_CA_FILE: file })).toEqual({
      tls: { ca: PEM },
    });
  });

  it('fails when the CA file is missing', () => {
    expect(() =>
      redisTlsOptions('rediss://redis:6379', { REDIS_TLS_CA_FILE: '/nonexistent/ca.crt' }),
    ).toThrow(/ENOENT/);
  });

  it('fails when a CA is set but the URL is plain redis://', () => {
    expect(() => redisTlsOptions('redis://redis:6379', { REDIS_TLS_CA_PEM: PEM })).toThrow(
      /not rediss/,
    );
    expect(() => redisTlsOptions('redis://redis:6379', { REDIS_TLS_CA_FILE: '/x' })).toThrow(
      /not rediss/,
    );
  });

  it('fails when both CA variables are set', () => {
    expect(() =>
      redisTlsOptions('rediss://redis:6379', { REDIS_TLS_CA_PEM: PEM, REDIS_TLS_CA_FILE: '/x' }),
    ).toThrow(/not both/);
  });
});

describe('createRedisClient', () => {
  beforeEach(() => {
    ctorCalls.length = 0;
    delete process.env['REDIS_TLS_CA_PEM'];
    delete process.env['REDIS_TLS_CA_FILE'];
  });

  it('passes the options through and logs connection errors', () => {
    const client = createRedisClient('redis://redis:6379', 'test', { lazyConnect: true });
    expect(ctorCalls[0]).toEqual(['redis://redis:6379', { lazyConnect: true }]);
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('adds the CA from the environment for rediss://', () => {
    process.env['REDIS_TLS_CA_PEM'] = PEM;
    createRedisClient('rediss://redis:6379', 'test', { maxRetriesPerRequest: null });
    expect(ctorCalls[0]).toEqual([
      'rediss://redis:6379',
      { maxRetriesPerRequest: null, tls: { ca: PEM } },
    ]);
    delete process.env['REDIS_TLS_CA_PEM'];
  });
});
