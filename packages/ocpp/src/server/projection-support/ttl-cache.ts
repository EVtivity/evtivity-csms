// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const CACHE_MAX_SIZE = 5000;
export const CACHE_TTL_MS = 300_000; // 5 minutes

export const CACHE_CLEANUP_INTERVAL_MS = 60_000; // 1 minute

export interface TtlCache<V> {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  delete: (key: string) => void;
}

export function createTtlCache<V>(): TtlCache<V> {
  const store = new Map<string, { value: V; expiresAt: number }>();

  // Periodic sweep removes all expired entries. This is the primary eviction
  // mechanism. The get() lazy-delete and set() overflow-delete are secondary.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, CACHE_CLEANUP_INTERVAL_MS);

  return {
    get(key: string): V | undefined {
      const entry = store.get(key);
      if (entry == null) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: V): void {
      // Only evict when inserting a new key (not updating an existing one).
      // The periodic sweep handles bulk expired-entry cleanup. This is just a
      // safety valve so the cache never exceeds CACHE_MAX_SIZE between sweeps.
      if (!store.has(key) && store.size >= CACHE_MAX_SIZE) {
        const firstKey = store.keys().next().value;
        if (firstKey != null) store.delete(firstKey);
      }
      store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    },
    delete(key: string): void {
      store.delete(key);
    },
  };
}
