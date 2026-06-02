// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { PersistedCache, type CachePersistor, type CacheLogger } from '../lib/persisted-cache.js';

function makeLogger(): CacheLogger & {
  calls: Array<{ msg: string; ctx?: Record<string, unknown> }>;
} {
  const calls: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
  return {
    calls,
    warn: (msg: string, ctx?: Record<string, unknown>) => {
      calls.push(ctx == null ? { msg } : { msg, ctx });
    },
  };
}

function makePersistor<K, V>(
  initial: Array<readonly [K, V]> = [],
): CachePersistor<K, V> & {
  upserts: Array<{ key: K; value: V }>;
  removes: K[];
  clears: number;
} {
  const upserts: Array<{ key: K; value: V }> = [];
  const removes: K[] = [];
  let clears = 0;
  return {
    upserts,
    removes,
    get clears() {
      return clears;
    },
    load: async () => initial,
    upsert: async (key, value) => {
      upserts.push({ key, value });
    },
    remove: async (key) => {
      removes.push(key);
    },
    clear: async () => {
      clears++;
    },
  };
}

describe('PersistedCache', () => {
  describe('load', () => {
    it('populates the in-memory map from the persistor on first load', async () => {
      const persistor = makePersistor<string, number>([
        ['a', 1],
        ['b', 2],
      ]);
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      await cache.load();

      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('is idempotent across multiple calls', async () => {
      const loadFn = vi.fn(async () => [['a', 1] as const]);
      const persistor: CachePersistor<string, number> = {
        load: loadFn,
        upsert: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      };
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      await cache.load();
      await cache.load();

      expect(loadFn).toHaveBeenCalledTimes(1);
    });

    it('logs a warning and starts empty when the persistor throws', async () => {
      const logger = makeLogger();
      const persistor: CachePersistor<string, number> = {
        load: async () => {
          throw new Error('db down');
        },
        upsert: async () => {},
        remove: async () => {},
      };
      const cache = new PersistedCache(persistor, logger, 'test');

      await cache.load();

      expect(cache.size).toBe(0);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.msg).toContain('test');
      expect(logger.calls[0]?.msg).toContain('load failed');
    });
  });

  describe('set', () => {
    it('mutates the in-memory map synchronously', () => {
      const persistor = makePersistor<string, number>();
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      cache.set('k', 7);

      expect(cache.get('k')).toBe(7);
    });

    it('fires the persistor upsert with the new value', async () => {
      const persistor = makePersistor<string, number>();
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      cache.set('k', 7);
      await new Promise((r) => setImmediate(r));

      expect(persistor.upserts).toEqual([{ key: 'k', value: 7 }]);
    });

    it('logs but does not throw when the persistor upsert rejects', async () => {
      const logger = makeLogger();
      const persistor: CachePersistor<string, number> = {
        load: async () => [],
        upsert: async () => {
          throw new Error('insert failed');
        },
        remove: async () => {},
      };
      const cache = new PersistedCache(persistor, logger, 'test');

      cache.set('k', 7);
      await new Promise((r) => setImmediate(r));

      expect(cache.get('k')).toBe(7);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.msg).toContain('upsert failed');
    });
  });

  describe('delete', () => {
    it('removes the in-memory entry and fires persistor.remove', async () => {
      const persistor = makePersistor<string, number>();
      const cache = new PersistedCache(persistor, makeLogger(), 'test');
      cache.set('k', 1);

      const had = cache.delete('k');
      await new Promise((r) => setImmediate(r));

      expect(had).toBe(true);
      expect(cache.has('k')).toBe(false);
      expect(persistor.removes).toEqual(['k']);
    });

    it('returns false and does not fire persistor.remove for missing keys', async () => {
      const persistor = makePersistor<string, number>();
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      const had = cache.delete('missing');
      await new Promise((r) => setImmediate(r));

      expect(had).toBe(false);
      expect(persistor.removes).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('empties the in-memory map and fires persistor.clear when defined', async () => {
      const persistor = makePersistor<string, number>();
      const cache = new PersistedCache(persistor, makeLogger(), 'test');
      cache.set('a', 1);
      cache.set('b', 2);

      cache.clear();
      await new Promise((r) => setImmediate(r));

      expect(cache.size).toBe(0);
      expect(persistor.clears).toBe(1);
    });

    it('silently skips persistor.clear when not defined', async () => {
      const persistor: CachePersistor<string, number> = {
        load: async () => [],
        upsert: async () => {},
        remove: async () => {},
      };
      const cache = new PersistedCache(persistor, makeLogger(), 'test');
      cache.set('a', 1);

      cache.clear();
      await new Promise((r) => setImmediate(r));

      expect(cache.size).toBe(0);
    });
  });

  describe('iteration', () => {
    it('exposes keys, values, entries, and [Symbol.iterator]', async () => {
      const persistor = makePersistor<string, number>([
        ['a', 1],
        ['b', 2],
      ]);
      const cache = new PersistedCache(persistor, makeLogger(), 'test');
      await cache.load();

      expect(Array.from(cache.keys()).sort()).toEqual(['a', 'b']);
      expect(Array.from(cache.values()).sort()).toEqual([1, 2]);
      expect(Array.from(cache.entries()).sort()).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      expect(Array.from(cache)).toEqual(Array.from(cache.entries()));
    });
  });

  describe('write-through semantics', () => {
    it('reading reflects the latest set even before persistor completes', async () => {
      const resolvers: Array<() => void> = [];
      const persistor: CachePersistor<string, number> = {
        load: async () => [],
        upsert: () =>
          new Promise<void>((r) => {
            resolvers.push(r);
          }),
        remove: async () => {},
      };
      const cache = new PersistedCache(persistor, makeLogger(), 'test');

      cache.set('k', 42);
      // Reading happens immediately; the persist promise is still pending.
      expect(cache.get('k')).toBe(42);
      // Resolve the persist promise so the test finishes cleanly.
      for (const r of resolvers) r();
    });
  });
});
