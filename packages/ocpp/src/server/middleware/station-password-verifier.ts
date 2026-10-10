// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { hash, needsRehash, verify } from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';

/**
 * Station Basic Auth password checks for the OCPP connection authentication.
 *
 * argon2id is CPU and memory bound, and every station connection runs one. A
 * reconnect wave on a small OCPP task spent nearly all its CPU on them, which
 * also slowed the messages of the stations already connected. Two parts keep
 * that bounded:
 *
 * - StationAuthCache remembers a successful check for a short time, so a
 *   station that reconnects to the same process skips argon2. Only successes
 *   are cached, so every wrong password still costs a full argon2 verify.
 * - A concurrency gate: at most `maxConcurrent` argon2 computations run at
 *   once (default: one less than the available CPUs and one less than the
 *   libuv thread pool size, at least 1). argon2 runs on the libuv thread pool,
 *   never on the event loop, but four parallel computations on one vCPU left
 *   the event loop a fifth of the CPU and took every libuv thread (DNS, zlib,
 *   crypto) for the duration.
 * - A per-station failed-attempt backoff: after STATION_AUTH_FAILURE_LIMIT
 *   wrong passwords within STATION_AUTH_FAILURE_WINDOW_MS, a station id gets
 *   no argon2 work for STATION_AUTH_LOCKOUT_MS, so a wrong-password flood on
 *   one id cannot fill the gate and starve the other stations. A cached
 *   success still passes, so the station holding the right password keeps
 *   reconnecting.
 * - Rehashes of hashes stored with older parameters run in the background,
 *   one at a time, after the connection is accepted (scheduleRehash).
 */

/** How long a successful password check is reused. Absolute, never extended by a hit. */
export const STATION_AUTH_CACHE_TTL_MS = 15 * 60_000;
/** Entries kept per process; the oldest is dropped first. */
export const STATION_AUTH_CACHE_MAX_ENTRIES = 100_000;

export interface StationAuthCacheOptions {
  ttlMs?: number | undefined;
  maxEntries?: number | undefined;
  now?: (() => number) | undefined;
}

interface CacheEntry {
  digest: Buffer;
  expiresAt: number;
}

/**
 * Per-process cache of successful station password checks, keyed on the
 * station's database id. An entry holds HMAC-SHA256(process key, stored hash,
 * password), never the password: the key is random per process and never
 * leaves memory. The stored hash is part of the digest and is read from the
 * database on every connection, so after a password change (a new hash with
 * a new salt) an old entry can never match, even before the invalidation
 * message evicts it.
 */
export class StationAuthCache {
  private readonly key = randomBytes(32);
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: StationAuthCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? STATION_AUTH_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? STATION_AUTH_CACHE_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  private digest(storedHash: string, password: string): Buffer {
    // A PHC hash string never contains NUL, so the input is unambiguous.
    return createHmac('sha256', this.key).update(storedHash).update('\0').update(password).digest();
  }

  /** True when this exact stored hash and password succeeded within the TTL. */
  matches(stationDbId: string, storedHash: string, password: string): boolean {
    const entry = this.entries.get(stationDbId);
    if (entry == null) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(stationDbId);
      return false;
    }
    return timingSafeEqual(entry.digest, this.digest(storedHash, password));
  }

  remember(stationDbId: string, storedHash: string, password: string): void {
    this.entries.delete(stationDbId);
    this.entries.set(stationDbId, {
      digest: this.digest(storedHash, password),
      expiresAt: this.now() + this.ttlMs,
    });
    // Map keeps insertion order: the first key is the oldest entry.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
  }

  invalidate(stationDbId: string): void {
    this.entries.delete(stationDbId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** FIFO concurrency gate for argon2 computations. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly maxConcurrent: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // The slot passes to the next waiter without being released.
      if (next != null) next();
      else this.active--;
    }
  }

  get queued(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }
}

/** libuv's thread pool size when UV_THREADPOOL_SIZE is not set. */
export const DEFAULT_LIBUV_THREADPOOL_SIZE = 4;

/** The libuv thread pool size: UV_THREADPOOL_SIZE (capped at 1024, as libuv does), else 4. */
export function libuvThreadpoolSize(
  value: string | undefined = process.env['UV_THREADPOOL_SIZE'],
): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIBUV_THREADPOOL_SIZE;
  return Math.min(n, 1024);
}

/**
 * One less than the available CPUs, so the event loop keeps a core, and one
 * less than the libuv thread pool, so DNS lookups (the database and Redis host
 * names), zlib and other crypto keep a thread; at least 1.
 *
 * availableParallelism() is libuv's uv_available_parallelism(), which honors
 * the Linux cgroup CPU quota (v1 cpu.cfs_quota_us, v2 cpu.max) since libuv
 * 1.49. Node 24, the minimum this package runs on, ships a newer libuv: a
 * container limited to 1.5 CPUs reports 1, not the host's CPU count.
 */
export function defaultArgon2Concurrency(
  cpus: number = availableParallelism(),
  threadpool: number = libuvThreadpoolSize(),
): number {
  return Math.max(1, Math.min(cpus - 1, threadpool - 1));
}

/** Wrong passwords for one station within the window before it is locked out. */
export const STATION_AUTH_FAILURE_LIMIT = 5;
export const STATION_AUTH_FAILURE_WINDOW_MS = 60_000;
/** How long a locked-out station gets no argon2 work. */
export const STATION_AUTH_LOCKOUT_MS = 60_000;
/** Stations tracked per process; the oldest is dropped first. */
export const STATION_AUTH_FAILURE_MAX_ENTRIES = 100_000;

export interface StationAuthBackoffOptions {
  limit?: number | undefined;
  windowMs?: number | undefined;
  lockoutMs?: number | undefined;
  maxEntries?: number | undefined;
  now?: (() => number) | undefined;
}

interface FailureEntry {
  windowStart: number;
  failures: number;
  lockedUntil: number;
}

/**
 * Per-process count of wrong station passwords, keyed on the station's
 * database id. Memory only, with a short TTL: a restart or another pod starts
 * from zero, which is enough for a backoff that protects this process's
 * argon2 gate.
 */
export class StationAuthBackoff {
  private readonly entries = new Map<string, FailureEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: StationAuthBackoffOptions = {}) {
    this.limit = Math.max(1, options.limit ?? STATION_AUTH_FAILURE_LIMIT);
    this.windowMs = options.windowMs ?? STATION_AUTH_FAILURE_WINDOW_MS;
    this.lockoutMs = options.lockoutMs ?? STATION_AUTH_LOCKOUT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? STATION_AUTH_FAILURE_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds left in this station's lockout; 0 when it may try. */
  lockedForMs(stationDbId: string): number {
    const entry = this.entries.get(stationDbId);
    if (entry == null) return 0;
    const now = this.now();
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.lockedUntil === 0 && now - entry.windowStart < this.windowMs) return 0;
    // The window or the lockout is over: forget the station.
    this.entries.delete(stationDbId);
    return 0;
  }

  recordFailure(stationDbId: string): void {
    const now = this.now();
    let entry = this.entries.get(stationDbId);
    if (entry == null || entry.lockedUntil !== 0 || now - entry.windowStart >= this.windowMs) {
      entry = { windowStart: now, failures: 0, lockedUntil: 0 };
    }
    entry.failures++;
    if (entry.failures >= this.limit) entry.lockedUntil = now + this.lockoutMs;
    this.entries.delete(stationDbId);
    this.entries.set(stationDbId, entry);
    // Map keeps insertion order: the first key is the oldest entry.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
  }

  recordSuccess(stationDbId: string): void {
    this.entries.delete(stationDbId);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Rehashes waiting for the background lane; more are dropped (the next connection retries). */
export const STATION_REHASH_MAX_PENDING = 1_000;

export interface StationPasswordVerifierOptions {
  /** null: no caching (every check runs argon2). */
  cache?: StationAuthCache | null | undefined;
  /** null: no failed-attempt backoff. Default: a StationAuthBackoff with the defaults. */
  backoff?: StationAuthBackoff | null | undefined;
  maxConcurrent?: number | undefined;
  maxPendingRehashes?: number | undefined;
}

export interface PasswordCheck {
  valid: boolean;
  /** The success came from the cache; no argon2 ran. */
  cached: boolean;
  /** Set when the station is locked out after repeated wrong passwords; no argon2 ran. */
  lockedForMs?: number | undefined;
}

export interface StationPasswordVerifierStats {
  cacheEntries: number;
  argon2Running: number;
  argon2Queued: number;
  argon2MaxConcurrent: number;
  rehashPending: number;
  backoffEntries: number;
}

export class StationPasswordVerifier {
  private readonly cache: StationAuthCache | null;
  private readonly backoff: StationAuthBackoff | null;
  private readonly gate: Gate;
  private readonly maxPendingRehashes: number;
  private readonly pendingRehashes = new Map<string, () => Promise<void>>();
  private rehashLane: Promise<void> | null = null;

  constructor(options: StationPasswordVerifierOptions = {}) {
    this.cache = options.cache ?? null;
    this.backoff = options.backoff === undefined ? new StationAuthBackoff() : options.backoff;
    this.gate = new Gate(Math.max(1, options.maxConcurrent ?? defaultArgon2Concurrency()));
    this.maxPendingRehashes = Math.max(1, options.maxPendingRehashes ?? STATION_REHASH_MAX_PENDING);
  }

  /**
   * Throws when the stored hash cannot be parsed (argon2 error). The cache is
   * checked before the lockout, so a flood of wrong passwords on a station id
   * never locks out the station that holds the right one.
   */
  async verify(stationDbId: string, storedHash: string, password: string): Promise<PasswordCheck> {
    if (this.cache?.matches(stationDbId, storedHash, password) === true) {
      return { valid: true, cached: true };
    }
    const lockedForMs = this.backoff?.lockedForMs(stationDbId) ?? 0;
    if (lockedForMs > 0) return { valid: false, cached: false, lockedForMs };
    const valid = await this.gate.run(() => verify(storedHash, password));
    if (valid) {
      this.cache?.remember(stationDbId, storedHash, password);
      this.backoff?.recordSuccess(stationDbId);
    } else {
      this.backoff?.recordFailure(stationDbId);
    }
    return { valid, cached: false };
  }

  /** True when the stored hash uses other parameters than STATION_PASSWORD_HASH_OPTIONS. */
  needsRehash(storedHash: string): boolean {
    try {
      return needsRehash(storedHash, {
        memoryCost: STATION_PASSWORD_HASH_OPTIONS.memoryCost,
        timeCost: STATION_PASSWORD_HASH_OPTIONS.timeCost,
        parallelism: STATION_PASSWORD_HASH_OPTIONS.parallelism,
      });
    } catch {
      // fail-open: an unparseable hash already failed verify, so it never gets here.
      return false;
    }
  }

  /** A new hash of the password with STATION_PASSWORD_HASH_OPTIONS. */
  rehash(password: string): Promise<string> {
    return this.gate.run(() => hash(password, { ...STATION_PASSWORD_HASH_OPTIONS }));
  }

  /**
   * Queues a background task (a rehash and its write) that runs after the
   * caller returns, one task at a time; its argon2 step goes through the gate,
   * so it never adds to the gate's limit. One entry per station: a second
   * schedule for a queued station is ignored. A full queue drops the task;
   * the stored hash is unchanged, so the next connection schedules it again.
   * The task logs its own errors.
   */
  scheduleRehash(stationDbId: string, task: () => Promise<void>): boolean {
    if (this.pendingRehashes.has(stationDbId)) return false;
    if (this.pendingRehashes.size >= this.maxPendingRehashes) return false;
    this.pendingRehashes.set(stationDbId, task);
    this.rehashLane ??= this.drainRehashes();
    return true;
  }

  private async drainRehashes(): Promise<void> {
    // Start after the current turn, so the connection result goes out first.
    await Promise.resolve();
    for (;;) {
      const next = this.pendingRehashes.entries().next();
      if (next.done === true) break;
      const [stationDbId, task] = next.value;
      try {
        await task();
      } catch {
        // fail-open: the task logs its own failure, and the next connection retries.
      } finally {
        this.pendingRehashes.delete(stationDbId);
      }
    }
    this.rehashLane = null;
  }

  /** Resolves when no background rehash is queued or running. */
  async whenRehashIdle(): Promise<void> {
    while (this.rehashLane != null) await this.rehashLane;
  }

  /** Records a success for a hash the caller stored itself (after a rehash). */
  remember(stationDbId: string, storedHash: string, password: string): void {
    this.cache?.remember(stationDbId, storedHash, password);
  }

  invalidate(stationDbId: string): void {
    this.cache?.invalidate(stationDbId);
  }

  stats(): StationPasswordVerifierStats {
    return {
      cacheEntries: this.cache?.size ?? 0,
      argon2Running: this.gate.running,
      argon2Queued: this.gate.queued,
      argon2MaxConcurrent: this.gate.maxConcurrent,
      rehashPending: this.pendingRehashes.size,
      backoffEntries: this.backoff?.size ?? 0,
    };
  }
}
