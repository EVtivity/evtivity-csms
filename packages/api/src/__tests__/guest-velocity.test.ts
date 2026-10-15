// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  GUEST_VELOCITY_KEY_PREFIX,
  checkGuestDeclines,
  countGuestDecline,
  countGuestStart,
  guestVelocityClientIp,
  isClientIpKnown,
  setGuestVelocityStore,
} from '../lib/guest-velocity.js';

const GUEST_STARTS_PER_IP_PER_HOUR = 30;
const GUEST_DECLINES_PER_IP_PER_HOUR = 5;
import type { GuestVelocityStore } from '../lib/guest-velocity.js';

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
// 12:30 UTC: 1800 seconds left in the hour window.
const NOW = Date.UTC(2026, 9, 15, 12, 30, 0);

function memoryStore(): GuestVelocityStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    increment(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
    read(key) {
      return Promise.resolve(counts.get(key) ?? 0);
    },
  };
}

afterEach(() => {
  setGuestVelocityStore(null);
});

describe('guest start velocity', () => {
  it('allows the hourly number of starts per IP and refuses the next', async () => {
    const store = memoryStore();
    setGuestVelocityStore(store);
    for (let i = 0; i < GUEST_STARTS_PER_IP_PER_HOUR; i++) {
      expect(await countGuestStart('1.2.3.4', GUEST_STARTS_PER_IP_PER_HOUR, log, NOW)).toBeNull();
    }
    expect(await countGuestStart('1.2.3.4', GUEST_STARTS_PER_IP_PER_HOUR, log, NOW)).toEqual({
      retryAfterSeconds: 1800,
    });
    // Another address has its own budget.
    expect(await countGuestStart('5.6.7.8', GUEST_STARTS_PER_IP_PER_HOUR, log, NOW)).toBeNull();
    expect([...store.counts.keys()].every((k) => k.startsWith(GUEST_VELOCITY_KEY_PREFIX))).toBe(
      true,
    );
  });

  it('refuses a new hold after the hourly number of declines', async () => {
    setGuestVelocityStore(memoryStore());
    for (let i = 0; i < GUEST_DECLINES_PER_IP_PER_HOUR - 1; i++) {
      await countGuestDecline('1.2.3.4', log, NOW);
    }
    expect(
      await checkGuestDeclines('1.2.3.4', GUEST_DECLINES_PER_IP_PER_HOUR, log, NOW),
    ).toBeNull();
    await countGuestDecline('1.2.3.4', log, NOW);
    expect(await checkGuestDeclines('1.2.3.4', GUEST_DECLINES_PER_IP_PER_HOUR, log, NOW)).toEqual({
      retryAfterSeconds: 1800,
    });
    // The next hour starts a new window.
    expect(
      await checkGuestDeclines('1.2.3.4', GUEST_DECLINES_PER_IP_PER_HOUR, log, NOW + 3600_000),
    ).toBeNull();
  });

  it('fails open when the counter store fails', async () => {
    setGuestVelocityStore({
      increment: () => Promise.reject(new Error('NOPERM')),
      read: () => Promise.reject(new Error('NOPERM')),
    });
    expect(await countGuestStart('1.2.3.4', GUEST_STARTS_PER_IP_PER_HOUR, log, NOW)).toBeNull();
    expect(
      await checkGuestDeclines('1.2.3.4', GUEST_DECLINES_PER_IP_PER_HOUR, log, NOW),
    ).toBeNull();
    await expect(countGuestDecline('1.2.3.4', log, NOW)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('guest velocity limits off', () => {
  it('counts nothing for an unknown client IP or a limit of 0', async () => {
    const store = memoryStore();
    setGuestVelocityStore(store);
    expect(await countGuestStart(null, 1, log, NOW)).toBeNull();
    await countGuestDecline(null, log, NOW);
    expect(await checkGuestDeclines(null, 1, log, NOW)).toBeNull();
    for (let i = 0; i < 50; i++) {
      expect(await countGuestStart('1.2.3.4', 0, log, NOW)).toBeNull();
    }
    expect(store.counts.size).toBe(0);
    await countGuestDecline('1.2.3.4', log, NOW);
    expect(await checkGuestDeclines('1.2.3.4', 0, log, NOW)).toBeNull();
  });
});

describe('real client IP', () => {
  const request = (ip: string) => ({ ip, log: { debug: vi.fn() } as unknown as FastifyBaseLogger });

  it('is known when TRUST_PROXY is set, whatever the address', () => {
    expect(isClientIpKnown('10.0.0.5', '10.0.0.0/8')).toBe(true);
    expect(guestVelocityClientIp(request('10.0.0.5'), '10.0.0.0/8')).toBe('10.0.0.5');
  });

  it('is known without TRUST_PROXY for a public socket address', () => {
    expect(isClientIpKnown('203.0.113.9', false)).toBe(false); // documentation range
    expect(isClientIpKnown('8.8.8.8', false)).toBe(true);
    expect(isClientIpKnown('2606:4700::1111', false)).toBe(true);
    expect(guestVelocityClientIp(request('8.8.8.8'), false)).toBe('8.8.8.8');
  });

  it('is not known without TRUST_PROXY for a private, loopback, link-local or unique-local address', () => {
    for (const ip of [
      '172.18.0.4',
      '192.168.1.10',
      '10.1.2.3',
      '127.0.0.1',
      '::1',
      '169.254.1.1',
      'fe80::1',
      'fd00::5',
    ]) {
      expect(isClientIpKnown(ip, false)).toBe(false);
    }
    const r = request('172.18.0.4');
    expect(guestVelocityClientIp(r, false)).toBeNull();
  });
});
