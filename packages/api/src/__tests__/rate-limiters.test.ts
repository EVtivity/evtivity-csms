// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isStationCheckRateLimited,
  stationCheckRateLimitSize,
  pendingStatusCheck,
  shareStatusCheck,
  getCachedConnectorStatus,
  setCachedConnectorStatus,
  isApiKeyRateLimited,
  isGuestSessionRateLimited,
  guestSessionRateLimitSize,
  GUEST_IP_RATE_LIMIT,
  GUEST_SESSION_RATE_LIMIT,
} from '../lib/rate-limiters.js';
import type { StatusCheckResult } from '../lib/station-status-check.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-04T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isStationCheckRateLimited', () => {
  it('gives every client of a station its own budget', () => {
    const station = 'sta_check_ip';
    for (let i = 0; i < 5; i++) isStationCheckRateLimited(station, '203.0.113.10');
    expect(isStationCheckRateLimited(station, '203.0.113.10')).toBe(true);
    // One client at its limit does not lock out another.
    expect(isStationCheckRateLimited(station, '198.51.100.7')).toBe(false);
  });

  it('allows up to 5 checks in a 60s window then blocks the 6th', () => {
    const station = 'sta_check_1';
    for (let i = 0; i < 5; i++) {
      expect(isStationCheckRateLimited(station, '203.0.113.1')).toBe(false);
    }
    expect(isStationCheckRateLimited(station, '203.0.113.1')).toBe(true);
  });

  it('lets requests through again after the window slides past 60s', () => {
    const station = 'sta_check_2';
    for (let i = 0; i < 5; i++) isStationCheckRateLimited(station, '203.0.113.1');
    expect(isStationCheckRateLimited(station, '203.0.113.1')).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(isStationCheckRateLimited(station, '203.0.113.1')).toBe(false);
  });

  it('prunes a fully-expired entry (recent empty but timestamps existed)', () => {
    const station = 'sta_check_3';
    isStationCheckRateLimited(station, '203.0.113.1');
    vi.advanceTimersByTime(61_000);
    // recent.length === 0 but timestamps.length > 0 -> delete branch, then re-add
    expect(isStationCheckRateLimited(station, '203.0.113.1')).toBe(false);
  });
});

describe('status check budget per client', () => {
  it('counts two addresses of one IPv6 /64 as one client budget', () => {
    const station = 'sta_check_v6';
    for (let i = 0; i < 5; i++)
      isStationCheckRateLimited(station, `2001:db8:5:6::${String(i + 1)}`);
    expect(isStationCheckRateLimited(station, '2001:db8:5:6:ffff::9')).toBe(true);
    // Another /64 has its own budget.
    expect(isStationCheckRateLimited(station, '2001:db8:5:7::1')).toBe(false);
  });

  it('sweeps the keys of clients with no check in the window', () => {
    for (let i = 0; i < 50; i++) isStationCheckRateLimited('sta_sweep', `198.51.100.${String(i)}`);
    const before = stationCheckRateLimitSize();
    expect(before).toBeGreaterThanOrEqual(50);
    vi.advanceTimersByTime(61_000);
    isStationCheckRateLimited('sta_sweep', '192.0.2.1');
    // The 50 idle keys are gone; the new one is added.
    expect(stationCheckRateLimitSize()).toBeLessThanOrEqual(before - 50 + 1);
  });

  it('runs one status check for every caller that arrives while it runs', async () => {
    let release: (v: StatusCheckResult) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<StatusCheckResult>((resolve) => {
          release = resolve;
        }),
    );
    const first = shareStatusCheck('sta_share', 1, run);
    const second = shareStatusCheck('sta_share', 1, run);
    expect(pendingStatusCheck('sta_share', 1)).toBe(first);
    expect(second).toBe(first);
    release({ status: 'Available' });
    await expect(first).resolves.toEqual({ status: 'Available' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(pendingStatusCheck('sta_share', 1)).toBeNull();
  });
});

describe('connector status cache', () => {
  it('returns null on a cold cache miss', () => {
    expect(getCachedConnectorStatus('sta_a', 1)).toBeNull();
  });

  it('stores and returns a status without error', () => {
    setCachedConnectorStatus('sta_b', 2, { status: 'Available' });
    expect(getCachedConnectorStatus('sta_b', 2)).toEqual({ status: 'Available' });
  });

  it('stores and returns a failed check with its error code', () => {
    setCachedConnectorStatus('sta_c', 3, { status: null, errorCode: 'STATUS_CHECK_TIMEOUT' });
    expect(getCachedConnectorStatus('sta_c', 3)).toEqual({
      status: null,
      errorCode: 'STATUS_CHECK_TIMEOUT',
    });
  });

  it('expires cached entries after the 30s TTL', () => {
    setCachedConnectorStatus('sta_d', 4, { status: 'Occupied' });
    vi.advanceTimersByTime(31_000);
    expect(getCachedConnectorStatus('sta_d', 4)).toBeNull();
  });

  it('keys cache by (stationId, evseId) so different EVSEs do not collide', () => {
    setCachedConnectorStatus('sta_e', 1, { status: 'Available' });
    setCachedConnectorStatus('sta_e', 2, { status: 'Faulted' });
    expect(getCachedConnectorStatus('sta_e', 1)).toEqual({ status: 'Available' });
    expect(getCachedConnectorStatus('sta_e', 2)).toEqual({ status: 'Faulted' });
  });
});

describe('isApiKeyRateLimited', () => {
  it('allows 60 requests then blocks the 61st', () => {
    const key = 'hash_1';
    for (let i = 0; i < 60; i++) {
      expect(isApiKeyRateLimited(key)).toBe(false);
    }
    expect(isApiKeyRateLimited(key)).toBe(true);
  });

  it('resets after the window slides', () => {
    const key = 'hash_2';
    for (let i = 0; i < 60; i++) isApiKeyRateLimited(key);
    expect(isApiKeyRateLimited(key)).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isApiKeyRateLimited(key)).toBe(false);
  });
});

describe('isGuestSessionRateLimited', () => {
  it('allows 30 requests per IP and session then blocks the 31st', () => {
    const ip = '203.0.113.5';
    for (let i = 0; i < 30; i++) {
      expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(false);
    }
    expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(true);
  });

  it('resets after the window slides past 60s', () => {
    const ip = '203.0.113.6';
    for (let i = 0; i < 30; i++) isGuestSessionRateLimited(ip, 'tok_a');
    expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(false);
  });

  it('lets two guests behind one IP poll their own sessions (finding G4)', () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 30; i++) {
      expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(false);
      expect(isGuestSessionRateLimited(ip, 'tok_b')).toBe(false);
    }
    expect(isGuestSessionRateLimited(ip, 'tok_a')).toBe(true);
    expect(isGuestSessionRateLimited(ip, 'tok_b')).toBe(true);
  });

  it('caps one IP at 120 requests a minute across session tokens', () => {
    const ip = '203.0.113.8';
    for (let i = 0; i < GUEST_IP_RATE_LIMIT; i++) {
      expect(isGuestSessionRateLimited(ip, `tok_${String(i)}`)).toBe(false);
    }
    expect(isGuestSessionRateLimited(ip, 'tok_new')).toBe(true);
    expect(GUEST_IP_RATE_LIMIT).toBe(120);
    expect(GUEST_SESSION_RATE_LIMIT).toBe(30);
  });

  it('sweeps expired entries once a window passes', () => {
    isGuestSessionRateLimited('203.0.113.9', 'tok_sweep');
    expect(guestSessionRateLimitSize()).toBeGreaterThan(0);
    // Past one window after any sweep the earlier tests ran (the module keeps state).
    vi.advanceTimersByTime(130_000);
    isGuestSessionRateLimited('203.0.113.10', 'tok_other');
    // Only the request just made is left: one session entry and one IP entry.
    expect(guestSessionRateLimitSize()).toBe(2);
  });
});
