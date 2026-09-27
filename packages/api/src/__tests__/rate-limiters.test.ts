// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isStationCheckRateLimited,
  getCachedConnectorStatus,
  setCachedConnectorStatus,
  isApiKeyRateLimited,
  isMfaChallengeExhausted,
  recordMfaChallengeAttempt,
  clearMfaChallengeAttempts,
  isGuestSessionRateLimited,
} from '../lib/rate-limiters.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-04T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isStationCheckRateLimited', () => {
  it('allows up to 5 checks in a 60s window then blocks the 6th', () => {
    const station = 'sta_check_1';
    for (let i = 0; i < 5; i++) {
      expect(isStationCheckRateLimited(station)).toBe(false);
    }
    expect(isStationCheckRateLimited(station)).toBe(true);
  });

  it('lets requests through again after the window slides past 60s', () => {
    const station = 'sta_check_2';
    for (let i = 0; i < 5; i++) isStationCheckRateLimited(station);
    expect(isStationCheckRateLimited(station)).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(isStationCheckRateLimited(station)).toBe(false);
  });

  it('prunes a fully-expired entry (recent empty but timestamps existed)', () => {
    const station = 'sta_check_3';
    isStationCheckRateLimited(station);
    vi.advanceTimersByTime(61_000);
    // recent.length === 0 but timestamps.length > 0 -> delete branch, then re-add
    expect(isStationCheckRateLimited(station)).toBe(false);
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

describe('MFA challenge attempt tracking', () => {
  it('is not exhausted before any attempts', () => {
    expect(isMfaChallengeExhausted(100)).toBe(false);
  });

  it('becomes exhausted after 5 recorded attempts', () => {
    for (let i = 0; i < 5; i++) recordMfaChallengeAttempt(101);
    expect(isMfaChallengeExhausted(101)).toBe(true);
  });

  it('is not exhausted at 4 attempts', () => {
    for (let i = 0; i < 4; i++) recordMfaChallengeAttempt(102);
    expect(isMfaChallengeExhausted(102)).toBe(false);
  });

  it('clearMfaChallengeAttempts resets the counter', () => {
    for (let i = 0; i < 5; i++) recordMfaChallengeAttempt(103);
    expect(isMfaChallengeExhausted(103)).toBe(true);
    clearMfaChallengeAttempts(103);
    expect(isMfaChallengeExhausted(103)).toBe(false);
  });
});

describe('isGuestSessionRateLimited', () => {
  it('allows 30 requests per IP then blocks the 31st', () => {
    const ip = '203.0.113.5';
    for (let i = 0; i < 30; i++) {
      expect(isGuestSessionRateLimited(ip)).toBe(false);
    }
    expect(isGuestSessionRateLimited(ip)).toBe(true);
  });

  it('resets after the window slides past 60s', () => {
    const ip = '203.0.113.6';
    for (let i = 0; i < 30; i++) isGuestSessionRateLimited(ip);
    expect(isGuestSessionRateLimited(ip)).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isGuestSessionRateLimited(ip)).toBe(false);
  });
});
