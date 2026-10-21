// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('@evtivity/lib', () => ({ createRedisClient: vi.fn() }));

import {
  RedisSamlRequestCache,
  SAML_BINDING_KEY_PREFIX,
  SAML_REQUEST_KEY_PREFIX,
  SAML_REQUEST_TTL_MS,
  samlBindingHash,
  ssoEmailDomainAllowed,
} from '../lib/saml-request-cache.js';

/** A Redis stand-in with the commands the cache uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  const set = vi.fn((key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  });
  const get = vi.fn((key: string) => Promise.resolve(store.get(key) ?? null));
  const del = vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0));
  const getdel = vi.fn((key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return Promise.resolve(value);
  });
  const redis = { set, get, del, getdel } as unknown as Redis;
  return { store, set, get, del, getdel, client: () => redis };
}

describe('RedisSamlRequestCache', () => {
  let redis: ReturnType<typeof fakeRedis>;

  beforeEach(() => {
    redis = fakeRedis();
  });

  it('saves a request id under the prefix with the TTL', async () => {
    const cache = new RedisSamlRequestCache(redis.client);
    const item = await cache.saveAsync('_req1', '2026-10-14T10:00:00Z');
    expect(item?.value).toBe('2026-10-14T10:00:00Z');
    expect(redis.set).toHaveBeenCalledWith(
      `${SAML_REQUEST_KEY_PREFIX}_req1`,
      '2026-10-14T10:00:00Z',
      'PX',
      SAML_REQUEST_TTL_MS,
    );
    expect(SAML_REQUEST_TTL_MS).toBe(600_000);
  });

  it('reads a saved id and answers null for a missing one', async () => {
    const cache = new RedisSamlRequestCache(redis.client);
    await cache.saveAsync('_req1', 'instant');
    expect(await cache.getAsync('_req1')).toBe('instant');
    expect(await cache.getAsync('_unknown')).toBeNull();
  });

  it('removes an id once', async () => {
    const cache = new RedisSamlRequestCache(redis.client);
    await cache.saveAsync('_req1', 'instant');
    expect(await cache.removeAsync('_req1')).toBe('_req1');
    expect(await cache.removeAsync('_req1')).toBeNull();
    expect(await cache.removeAsync(null)).toBeNull();
  });

  it('lets only one of two posts of a reply consume its request id', async () => {
    await new RedisSamlRequestCache(redis.client).saveAsync('_req1', 'instant');
    const first = new RedisSamlRequestCache(redis.client);
    const second = new RedisSamlRequestCache(redis.client);
    expect(await first.getAsync('_req1')).toBe('instant');
    expect(await second.getAsync('_req1')).toBe('instant');
    expect(await first.consumeRead()).toBe(true);
    expect(await second.consumeRead()).toBe(false);
    expect(redis.store.size).toBe(0);
  });

  it('counts a removal node-saml already made while checking the assertion', async () => {
    await new RedisSamlRequestCache(redis.client).saveAsync('_req1', 'instant');
    const cache = new RedisSamlRequestCache(redis.client);
    await cache.getAsync('_req1');
    await cache.removeAsync('_req1');
    expect(await cache.consumeRead()).toBe(true);
  });

  it('consumes nothing when no id was read', async () => {
    expect(await new RedisSamlRequestCache(redis.client).consumeRead()).toBe(false);
  });
});

describe('SAML browser binding (security review L1)', () => {
  let redis: ReturnType<typeof fakeRedis>;

  beforeEach(() => {
    redis = fakeRedis();
  });

  it('stores the binding hash beside the request id, never the cookie value', async () => {
    const login = new RedisSamlRequestCache(redis.client, samlBindingHash('cookie-value'));
    await login.saveAsync('_req1', 'instant');
    expect(redis.store.get(`${SAML_BINDING_KEY_PREFIX}_req1`)).toBe(
      samlBindingHash('cookie-value'),
    );
    expect([...redis.store.values()]).not.toContain('cookie-value');
  });

  it('matches only the cookie of the browser that started the request, once', async () => {
    await new RedisSamlRequestCache(redis.client, samlBindingHash('victim')).saveAsync(
      '_req1',
      'i',
    );
    const attacker = new RedisSamlRequestCache(redis.client);
    await attacker.getAsync('_req1');
    expect(await attacker.bindingMatches('attacker')).toBe(false);
    // The binding was read once: even the right cookie cannot use it again.
    const replay = new RedisSamlRequestCache(redis.client);
    await replay.getAsync('_req1');
    expect(await replay.bindingMatches('victim')).toBe(false);

    await new RedisSamlRequestCache(redis.client, samlBindingHash('victim')).saveAsync(
      '_req2',
      'i',
    );
    const callback = new RedisSamlRequestCache(redis.client);
    await callback.getAsync('_req2');
    expect(await callback.bindingMatches('victim')).toBe(true);
  });

  it('refuses a request saved without a binding and a missing cookie', async () => {
    await new RedisSamlRequestCache(redis.client).saveAsync('_req1', 'i');
    const callback = new RedisSamlRequestCache(redis.client);
    await callback.getAsync('_req1');
    expect(await callback.bindingMatches('anything')).toBe(false);
    await new RedisSamlRequestCache(redis.client, samlBindingHash('v')).saveAsync('_req2', 'i');
    const noCookie = new RedisSamlRequestCache(redis.client);
    await noCookie.getAsync('_req2');
    expect(await noCookie.bindingMatches(null)).toBe(false);
  });
});

describe('ssoEmailDomainAllowed', () => {
  it('allows every domain when the list is empty', () => {
    expect(ssoEmailDomainAllowed('a@any.com', [])).toBe(true);
  });

  it('allows a listed domain whatever its case and refuses others', () => {
    expect(ssoEmailDomainAllowed('a@Corp.COM', ['corp.com'])).toBe(true);
    expect(ssoEmailDomainAllowed('a@other.com', ['corp.com'])).toBe(false);
    expect(ssoEmailDomainAllowed('no-at-sign', ['corp.com'])).toBe(false);
  });
});
