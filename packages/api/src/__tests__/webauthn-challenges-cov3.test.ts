// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// WebAuthn ceremony challenges in Redis: stored with a TTL under the nonce
// prefix and read once.

import { describe, it, expect, vi } from 'vitest';

const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    getdel: vi.fn((key: string) => {
      const v = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(v);
    }),
  };
});
const createRedisClient = vi.hoisted(() => vi.fn(() => redis));

vi.mock('@evtivity/lib', () => ({
  createRedisClient,
  tryParseJson: (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return undefined;
      throw err;
    }
  },
}));
vi.mock('../lib/config.js', () => ({ config: { REDIS_URL: 'redis://test' } }));

import { saveWebauthnChallenge, takeWebauthnChallenge } from '../lib/webauthn-challenges.js';

describe('webauthn challenges', () => {
  it('stores a challenge for 300 s and answers it once', async () => {
    await saveWebauthnChallenge('abc', { purpose: 'passkey_login', realm: 'driver' });
    expect(redis.set).toHaveBeenCalledWith(
      'attest:nonce:webauthn:abc',
      JSON.stringify({ purpose: 'passkey_login', realm: 'driver' }),
      'EX',
      300,
    );
    expect(await takeWebauthnChallenge('abc')).toEqual({
      purpose: 'passkey_login',
      realm: 'driver',
    });
    expect(await takeWebauthnChallenge('abc')).toBeNull();
    // One client for the process.
    await saveWebauthnChallenge('def', { userId: 'usr_1', purpose: 'second_factor' });
    expect(createRedisClient).toHaveBeenCalledTimes(1);
    expect(createRedisClient).toHaveBeenCalledWith('redis://test', 'webauthn-challenges', {
      maxRetriesPerRequest: 2,
    });
  });

  it('answers null for an empty challenge without reading Redis', async () => {
    expect(await takeWebauthnChallenge('')).toBeNull();
    expect(redis.getdel).not.toHaveBeenCalled();
  });
});
