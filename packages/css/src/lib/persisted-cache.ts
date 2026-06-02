// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface CachePersistor<K, V> {
  load(): Promise<Iterable<readonly [K, V]>>;
  upsert(key: K, value: V): Promise<void>;
  remove(key: K): Promise<void>;
  clear?(): Promise<void>;
}

export interface CacheLogger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Map-shaped write-through cache for simulator state that must stay in sync
 * with its css_* DB table. `set`/`delete` mutate in-memory and fire-and-forget
 * the persistor; reads are local. `load()` populates the cache from DB once
 * and is idempotent.
 *
 * Values are intended to be replaced via `set(key, newValue)`, never mutated
 * in place — the cache can't observe in-place mutations and the DB would
 * silently diverge. Treat values as immutable.
 */
export class PersistedCache<K, V> {
  private readonly map = new Map<K, V>();
  private loaded = false;

  constructor(
    private readonly persistor: CachePersistor<K, V>,
    private readonly logger: CacheLogger,
    private readonly name: string,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      for (const [k, v] of await this.persistor.load()) {
        this.map.set(k, v);
      }
    } catch (err: unknown) {
      this.logger.warn(`PersistedCache ${this.name} load failed; starting empty`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    this.loaded = true;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  set(key: K, value: V): void {
    this.map.set(key, value);
    void this.persistor.upsert(key, value).catch((err: unknown) => {
      this.logger.warn(`PersistedCache ${this.name} upsert failed`, {
        key: String(key),
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  delete(key: K): boolean {
    const had = this.map.delete(key);
    if (had) {
      void this.persistor.remove(key).catch((err: unknown) => {
        this.logger.warn(`PersistedCache ${this.name} remove failed`, {
          key: String(key),
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return had;
  }

  clear(): void {
    this.map.clear();
    if (this.persistor.clear != null) {
      void this.persistor.clear().catch((err: unknown) => {
        this.logger.warn(`PersistedCache ${this.name} clear failed`, {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}
