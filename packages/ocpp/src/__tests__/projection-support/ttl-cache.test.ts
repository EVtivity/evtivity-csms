// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_CLEANUP_INTERVAL_MS,
  CACHE_MAX_SIZE,
  CACHE_TTL_MS,
  createTtlCache,
} from '../../server/projection-support/ttl-cache.js';

describe('createTtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an entry before the TTL and drops it after', () => {
    const cache = createTtlCache<string>();
    cache.set('a', 'one');

    vi.setSystemTime(Date.now() + CACHE_TTL_MS);
    expect(cache.get('a')).toBe('one');

    vi.setSystemTime(Date.now() + 1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('keeps a stored null apart from a missing key', () => {
    const cache = createTtlCache<string | null>();
    cache.set('a', null);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeUndefined();
  });

  it('deletes an entry', () => {
    const cache = createTtlCache<string>();
    cache.set('a', 'one');
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the oldest key when a new key would exceed the max size', () => {
    const cache = createTtlCache<number>();
    for (let i = 0; i < CACHE_MAX_SIZE; i++) cache.set(`k${String(i)}`, i);

    cache.set('k0', 100);
    expect(cache.get('k0')).toBe(100);
    expect(cache.get('k1')).toBe(1);

    cache.set('new', -1);
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('new')).toBe(-1);
  });

  it('creates one cleanup interval per cache', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    createTtlCache<string>();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), CACHE_CLEANUP_INTERVAL_MS);
    spy.mockRestore();
  });

  it('sweeps expired entries on the cleanup interval', () => {
    const cache = createTtlCache<string>();
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    cache.set('a', 'one');

    vi.advanceTimersByTime(CACHE_TTL_MS + CACHE_CLEANUP_INTERVAL_MS);
    expect(deleteSpy).toHaveBeenCalledWith('a');
    deleteSpy.mockRestore();
    expect(cache.get('a')).toBeUndefined();
  });
});
