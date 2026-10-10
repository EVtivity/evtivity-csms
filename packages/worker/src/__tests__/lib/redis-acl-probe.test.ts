// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import {
  probeWorkerLockGrants,
  RedisAclGrantMissingError,
  WORKER_LOCK_PREFIXES,
} from '../../lib/redis-acl-probe.js';

function noPerm(key: string): Error {
  return new Error(`NOPERM No permissions to access a key (${key}) for the 'set' command`);
}

function fakeRedis(denied: string[] = [], failWith?: Error) {
  return {
    set: vi.fn((key: string) => {
      if (failWith != null) return Promise.reject(failWith);
      if (denied.some((p) => key.startsWith(p))) return Promise.reject(noPerm(key));
      return Promise.resolve('OK' as const);
    }),
    del: vi.fn(() => Promise.resolve(1)),
  };
}

describe('probeWorkerLockGrants', () => {
  it('sets and deletes a short-lived probe key under every lock prefix', async () => {
    const redis = fakeRedis();
    await probeWorkerLockGrants(redis);
    expect(redis.set).toHaveBeenCalledTimes(WORKER_LOCK_PREFIXES.length);
    for (const [i, prefix] of WORKER_LOCK_PREFIXES.entries()) {
      const call = redis.set.mock.calls[i] as unknown as unknown[];
      expect(String(call[0]).startsWith(`${prefix}probe:`)).toBe(true);
      expect(call.slice(1)).toEqual(['1', 'PX', 10_000, 'NX']);
      expect(redis.del).toHaveBeenNthCalledWith(i + 1, call[0]);
    }
  });

  it('names every missing grant when the ACL denies a prefix', async () => {
    const redis = fakeRedis(['wkl:']);
    const err = await probeWorkerLockGrants(redis as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisAclGrantMissingError);
    expect((err as RedisAclGrantMissingError).missing).toEqual(['wkl:']);
    expect((err as Error).message).toContain('~wkl:*');
    expect(redis.del).toHaveBeenCalledTimes(WORKER_LOCK_PREFIXES.length - 1);
  });

  it('rethrows errors other than NOPERM', async () => {
    const redis = fakeRedis([], new Error('ECONNREFUSED'));
    await expect(probeWorkerLockGrants(redis as never)).rejects.toThrow('ECONNREFUSED');
  });
});
