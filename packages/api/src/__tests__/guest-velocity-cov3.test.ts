// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { createRedisClient, redis, execResults } = vi.hoisted(() => {
  const execResults: unknown[] = [];
  const tx = {
    incr: vi.fn(() => tx),
    expire: vi.fn(() => tx),
    exec: vi.fn(async () => execResults.shift()),
  };
  const redis = { multi: vi.fn(() => tx), get: vi.fn(), tx };
  return { createRedisClient: vi.fn(() => redis), redis, execResults };
});

vi.mock('@evtivity/lib', () => ({
  createRedisClient,
  isNonPublicAddress: (ip: string) => ip.startsWith('10.') || ip === '127.0.0.1',
}));
vi.mock('../lib/config.js', () => ({
  config: { REDIS_URL: 'redis://t:6379', TRUST_PROXY: false },
}));

import {
  checkGuestDeclines,
  countGuestDecline,
  countGuestStart,
  guestVelocityClientIp,
  setGuestVelocityStore,
} from '../lib/guest-velocity.js';

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
// 12:30 UTC: 1800 seconds left in the hour window; window number 493164.
const NOW = Date.UTC(2026, 9, 15, 12, 30, 0);
const WINDOW = String(Math.floor(NOW / 1000 / 3600));

beforeEach(() => {
  setGuestVelocityStore(null);
  execResults.length = 0;
});

describe('guest velocity on Redis', () => {
  it('counts a start in a MULTI with EXPIRE NX on the hour window key', async () => {
    execResults.push([[null, 31]]);
    expect(await countGuestStart('203.0.113.9', 30, log, NOW)).toEqual({ retryAfterSeconds: 1800 });
    expect(createRedisClient).toHaveBeenCalledWith('redis://t:6379', 'guest-velocity', {
      maxRetriesPerRequest: 2,
    });
    const key = `guest:vl:start:203.0.113.9:${WINDOW}`;
    expect(redis.tx.incr).toHaveBeenCalledWith(key);
    expect(redis.tx.expire).toHaveBeenCalledWith(key, 3600, 'NX');
  });

  it('allows the start when the transaction fails, is discarded or returns no count', async () => {
    execResults.push([[new Error('NOPERM'), null]], null, [[null, 'x']]);
    for (let i = 0; i < 3; i += 1) {
      expect(await countGuestStart('203.0.113.9', 30, log, NOW)).toBeNull();
    }
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(log.warn).mock.calls.map((c) => (c[0] as { err: Error }).err.message)).toEqual(
      ['NOPERM', 'Redis transaction was discarded', 'Redis INCR returned no count'],
    );
  });

  it('reads the decline count, absent and non-numeric values as 0', async () => {
    redis.get.mockResolvedValueOnce('5').mockResolvedValueOnce(null).mockResolvedValueOnce('abc');
    expect(await checkGuestDeclines('203.0.113.9', 5, log, NOW)).toEqual({
      retryAfterSeconds: 1800,
    });
    expect(redis.get).toHaveBeenCalledWith(`guest:vl:decline:203.0.113.9:${WINDOW}`);
    expect(await checkGuestDeclines('203.0.113.9', 1, log, NOW)).toBeNull();
    expect(await checkGuestDeclines('203.0.113.9', 1, log, NOW)).toBeNull();
  });

  it('allows the hold when the decline read fails and logs the failed decline count', async () => {
    redis.get.mockRejectedValueOnce(new Error('down'));
    expect(await checkGuestDeclines('203.0.113.9', 5, log, NOW)).toBeNull();
    execResults.push([[new Error('down'), null]]);
    await countGuestDecline('203.0.113.9', log, NOW);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Guest decline velocity counter failed',
    );
  });

  it('counts nothing for an unknown IP', async () => {
    await countGuestDecline(null, log, NOW);
    expect(redis.multi).not.toHaveBeenCalled();
  });
});

describe('guestVelocityClientIp', () => {
  it('logs the unknown client IP once per process and uses the configured TRUST_PROXY by default', () => {
    const debug = vi.fn();
    const request = { ip: '10.0.0.5', log: { debug } } as never;
    expect(guestVelocityClientIp(request)).toBeNull();
    expect(guestVelocityClientIp(request)).toBeNull();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(guestVelocityClientIp({ ip: '203.0.113.9', log: { debug } } as never)).toBe(
      '203.0.113.9',
    );
  });
});
