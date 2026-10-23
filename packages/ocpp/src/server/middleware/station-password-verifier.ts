// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { deriveKey, KEY_LABELS } from '@evtivity/lib/derived-keys';
import { availableParallelism } from 'node:os';
import { hash, needsRehash, verify } from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';
import { clientAddressKey } from '@evtivity/lib/ip-address';

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
 * - Trust comes only from a proven credential: a password that matches the
 *   cache or the recent-success digest (STATION_RECENT_SUCCESS_MS) of the
 *   stored hash needs no argon2 and passes every limit below. An address or
 *   a header never counts as trust.
 * - One argon2 verify in flight per station: every other check waits for it
 *   (at most STATION_AUTH_MAX_WAITERS per station and client address, for at
 *   most STATION_AUTH_MAX_WAIT_MS, else retry later), then checks the known
 *   good credentials and the lockouts again, so parallel wrong passwords for
 *   one station hold one argon2 slot and are all counted, so a burst of
 *   parallel connections cannot hold a slot per guess.
 * - A per-IP failed-attempt backoff across station ids: after
 *   IP_AUTH_FAILURE_LIMIT wrong passwords from one address (an IPv6 /64) within
 *   the window, that address gets no argon2 work for any station, so one
 *   client cannot spread its guesses over many known station ids.
 *   Stations behind the same NAT that hold a known-good credential still pass.
 * - A per-station failure budget across addresses and processes: at most
 *   STATION_WIDE_FAILURE_LIMIT checks a minute per station id, each reserved
 *   in Redis (StationAttemptStore) in the same atomic step that reads the
 *   count, so every OCPP process shares it and a parallel burst never passes
 *   it; a right password refunds its place. Past it every other check of that
 *   station goes to a slow check per station and address (IPv4 address, IPv6
 *   /48): one full verify per STATION_SLOW_CHECK_INTERVAL_MS for each pair,
 *   also shared. An address can then only use its own slow check, never the
 *   one of the real station at another address, and one IPv6 allocation gets
 *   one slow check, not one per /64. The real station is not refused: a
 *   station connected within STATION_RECENT_SUCCESS_MS holds a known-good
 *   record (each process keeps the records of the stations it holds fresh,
 *   refreshKnownGood) and connects at once; one offline longer gets its own
 *   slow check within a minute. Many distinct IPv4 addresses or IPv6 /48s can
 *   raise the total guess rate past the budget; the per-address lockout and
 *   slow lane cap each address. A Redis failure falls back to the same
 *   counters per process, logged.
 * - Rehashes of hashes stored with older parameters run in the background,
 *   one at a time, after the connection is accepted (scheduleRehash).
 */

/** How long a successful password check is reused. Absolute, never extended by a hit. */
export const STATION_AUTH_CACHE_TTL_MS = 15 * 60_000;
/**
 * How long a successful check stays a known-good credential: the same digest
 * (stored hash and password), so a password change ends it. A known-good
 * credential needs no argon2 and passes every admission limit.
 */
export const STATION_RECENT_SUCCESS_MS = 24 * 60 * 60_000;
/** Entries kept per process; the oldest is dropped first. */
export const STATION_AUTH_CACHE_MAX_ENTRIES = 100_000;

export interface StationAuthCacheOptions {
  ttlMs?: number | undefined;
  /** How long a success stays a known-good credential (STATION_RECENT_SUCCESS_MS). */
  recentTtlMs?: number | undefined;
  maxEntries?: number | undefined;
  now?: (() => number) | undefined;
}

interface CacheEntry {
  digest: Buffer;
  expiresAt: number;
}

interface PresentedEntry extends CacheEntry {
  stationDbId: string;
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
  // The same successes by station identity (the URL station id) and password
  // only, so a request can be told apart before its station lookup: the
  // server lets it past the authentication queue. The full check (stored hash
  // included) still runs after the lookup.
  private readonly presented = new Map<string, PresentedEntry>();
  private readonly identityOf = new Map<string, string>();
  // Known-good credentials: the same digest kept STATION_RECENT_SUCCESS_MS. A
  // match is a password proven good for this stored hash, so it needs no
  // argon2 and no limit applies to it. Only a proven credential is trusted,
  // never an address or a header.
  private readonly recent = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly recentTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: StationAuthCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? STATION_AUTH_CACHE_TTL_MS;
    this.recentTtlMs = Math.max(this.ttlMs, options.recentTtlMs ?? STATION_RECENT_SUCCESS_MS);
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

  /** True when this stored hash and password succeeded within STATION_RECENT_SUCCESS_MS. */
  matchesKnownGood(stationDbId: string, storedHash: string, password: string): boolean {
    const entry = this.recent.get(stationDbId);
    if (entry == null) return false;
    if (entry.expiresAt <= this.now()) {
      this.recent.delete(stationDbId);
      return false;
    }
    return timingSafeEqual(entry.digest, this.digest(storedHash, password));
  }

  private presentedDigest(stationId: string, password: string): Buffer {
    return createHmac('sha256', this.key)
      .update('presented\0')
      .update(stationId)
      .update('\0')
      .update(password)
      .digest();
  }

  /** True when this station identity and password succeeded within the TTL. */
  matchesPresented(stationId: string, password: string): boolean {
    const entry = this.presented.get(stationId);
    if (entry == null) return false;
    if (entry.expiresAt <= this.now()) {
      this.presented.delete(stationId);
      return false;
    }
    return timingSafeEqual(entry.digest, this.presentedDigest(stationId, password));
  }

  remember(stationDbId: string, storedHash: string, password: string, stationId?: string): void {
    this.entries.delete(stationDbId);
    const expiresAt = this.now() + this.ttlMs;
    const knownGoodUntil = this.now() + this.recentTtlMs;
    const digest = this.digest(storedHash, password);
    this.entries.set(stationDbId, { digest, expiresAt });
    this.recent.delete(stationDbId);
    this.recent.set(stationDbId, { digest, expiresAt: knownGoodUntil });
    if (stationId != null) {
      const previous = this.identityOf.get(stationDbId);
      if (previous != null) this.presented.delete(previous);
      this.presented.delete(stationId);
      this.presented.set(stationId, {
        digest: this.presentedDigest(stationId, password),
        expiresAt: knownGoodUntil,
        stationDbId,
      });
      this.identityOf.set(stationDbId, stationId);
    }
    // Map keeps insertion order: the first key is the oldest entry.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
    while (this.recent.size > this.maxEntries) {
      const oldest = this.recent.keys().next().value;
      if (oldest == null) break;
      this.invalidate(oldest);
    }
  }

  invalidate(stationDbId: string): void {
    this.entries.delete(stationDbId);
    this.recent.delete(stationDbId);
    const stationId = this.identityOf.get(stationDbId);
    if (stationId != null) {
      this.identityOf.delete(stationDbId);
      if (this.presented.get(stationId)?.stationDbId === stationDbId) {
        this.presented.delete(stationId);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.recent.clear();
    this.presented.clear();
    this.identityOf.clear();
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
 * Backoff key: the station database id plus the client IP (the address the
 * server already resolves through its trusted proxies, never a raw header;
 * an IPv6 address by its /64), so wrong passwords sent from one address never
 * lock the station out of another. An unknown address shares one key per
 * station.
 */
export function stationAuthBackoffKey(stationDbId: string, clientIp: string | null): string {
  return `${stationDbId}|${clientIp == null ? 'unknown' : clientAddressKey(clientIp)}`;
}

/** Wrong passwords from one address (an IPv6 /64), any station, before it is locked out. */
export const IP_AUTH_FAILURE_LIMIT = 20;

/**
 * Per-process count of wrong station passwords, keyed on
 * `stationAuthBackoffKey` (station database id and client IP). Memory only,
 * with a short TTL: a restart or another pod starts from zero, which is enough
 * for a backoff that protects this process's argon2 gate.
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
    if (entry != null && entry.lockedUntil > now) {
      // A failure during the lockout (a slow-lane verify) extends it.
      entry.failures++;
      entry.lockedUntil = now + this.lockoutMs;
    } else {
      if (entry == null || entry.lockedUntil !== 0 || now - entry.windowStart >= this.windowMs) {
        entry = { windowStart: now, failures: 0, lockedUntil: 0 };
      }
      entry.failures++;
      if (entry.failures >= this.limit) entry.lockedUntil = now + this.lockoutMs;
    }
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
  /**
   * Per-IP backoff across station ids. null: none. Default: none when
   * `backoff` is null, else IP_AUTH_FAILURE_LIMIT wrong passwords a minute.
   */
  ipBackoff?: StationAuthBackoff | null | undefined;
  maxConcurrent?: number | undefined;
  maxPendingRehashes?: number | undefined;
  /** Checks that may wait for a station's verify in flight (STATION_AUTH_MAX_WAITERS). */
  maxWaiters?: number | undefined;
  /** Longest wait for a station's verify in flight (STATION_AUTH_MAX_WAIT_MS). */
  maxWaitMs?: number | undefined;
  /** Interval between two slow-lane verifies of one address or station (SLOW_LANE_INTERVAL_MS). */
  slowLaneIntervalMs?: number | undefined;
  /** Slow-lane verifies at once per process (SLOW_LANE_MAX_ACTIVE). */
  slowLaneMaxActive?: number | undefined;
  /**
   * Wrong passwords per station from every address. null: none. Default: none
   * when `backoff` is null, else STATION_WIDE_FAILURE_LIMIT a minute.
   */
  stationWideBackoff?: StationAuthBackoff | null | undefined;
  /** Longest wait for the shared known-good and attempt stores (KNOWN_GOOD_STORE_TIMEOUT_MS). */
  knownGoodStoreTimeoutMs?: number | undefined;
  /** Interval between two slow checks of one station id (STATION_SLOW_CHECK_INTERVAL_MS). */
  stationSlowCheckIntervalMs?: number | undefined;
  /** Logs a fall back to the local counters when the shared attempt store fails. */
  logger?: { warn: (obj: unknown, msg: string) => void } | undefined;
}

/** Checks from one client address that may wait for one station's verify in flight; more retry later. */
export const STATION_AUTH_MAX_WAITERS = 10;
/** Longest wait for one station's verify in flight. */
export const STATION_AUTH_MAX_WAIT_MS = 5_000;
/** Retry-After of a check refused because its station's waiters were full. */
export const STATION_AUTH_BUSY_RETRY_MS = 1_000;
/**
 * A locked-out address verifies at most one password per this interval (slow
 * lane): 12 a minute, below the IP_AUTH_FAILURE_LIMIT a minute that locked it,
 * so the lockout never raises its guess rate.
 */
export const SLOW_LANE_INTERVAL_MS = 5_000;
/**
 * Wrong passwords for one station id a minute, from every address and process
 * together, before its other checks go to the slow check of their address.
 */
export const STATION_WIDE_FAILURE_LIMIT = 20;
export const STATION_WIDE_WINDOW_MS = 60_000;
/**
 * A station id past its budget verifies at most one password per this
 * interval for each client address key, shared by every process: one address
 * gets one check a minute for the station, whatever the number of processes.
 */
export const STATION_SLOW_CHECK_INTERVAL_MS = 60_000;
/** How often a process refreshes the known-good record of a station it holds. */
export const KNOWN_GOOD_REFRESH_INTERVAL_MS = 60 * 60_000;
/** A fall back to the local counters is logged at most once per this interval. */
const ATTEMPT_STORE_FALLBACK_LOG_MS = 60_000;
/**
 * Longest wait for the shared known-good store (Redis). Past it the read is a
 * miss and argon2 runs, so a Redis outage never holds a connection slot for
 * the client's retry period.
 */
export const KNOWN_GOOD_STORE_TIMEOUT_MS = 200;
/** Slow-lane verifies (locked addresses and stations) running at once per process; more retry later. */
export const SLOW_LANE_MAX_ACTIVE = 50;
/** Addresses and stations tracked by the slow lane per process; the oldest is dropped first. */
const SLOW_LANE_MAX_ENTRIES = 100_000;

/**
 * Successes shared by every OCPP process (Redis, `ocpp:auth:ok:<station db id>`),
 * so a known-good credential survives a restart and works on every pod. The
 * value is an HMAC of the stored hash and the password under a key derived
 * from SETTINGS_ENCRYPTION_KEY, never the password. Failures are fail-open:
 * the check then runs argon2 as without a store.
 */
export interface KnownGoodStore {
  get(stationDbId: string): Promise<string | null>;
  set(stationDbId: string, digest: string, ttlMs: number): Promise<void>;
  delete(stationDbId: string): Promise<void>;
  /**
   * Moves the expiry of the records of these stations to `ttlMs` from now.
   * Only a record that exists: never creates one (a record comes only from a
   * successful verify).
   */
  touch(stationDbIds: readonly string[], ttlMs: number): Promise<void>;
}

/** What the shared station failure budget decided for one check. */
export type StationCheckTake =
  /**
   * Within the station's budget; this check reserved one place in the fixed
   * window `window` (`floor(now / windowMs)`), refunded in that window only
   * when it succeeds.
   */
  | { kind: 'counted'; window: number }
  /** Past the budget; this check holds the slow check of its station and address under `token`. */
  | { kind: 'slow'; token: string }
  /** Past the budget; another check holds the slow check of this station and address for `retryMs`. */
  | { kind: 'wait'; retryMs: number };

/**
 * The station failure budget shared by every OCPP process (Redis,
 * `ocpp:auth:fail:<station db id>:<window>` and
 * `ocpp:auth:slow:<station db id>:<slow check address key>`). Each call is one
 * atomic step; a failure throws, and the verifier then uses its local counters.
 */
export interface StationAttemptStore {
  /**
   * Within the budget: reserves one place in the same step that reads the
   * count of the current fixed window (`floor(now / windowMs)`, in the key),
   * so parallel checks never pass the budget. Past it: the slow check of this station and address, held under
   * `token` for `slowIntervalMs`, when free; else wait.
   */
  take(
    stationDbId: string,
    addressKey: string,
    limit: number,
    windowMs: number,
    slowIntervalMs: number,
    token: string,
  ): Promise<StationCheckTake>;
  /**
   * Gives a reserved place back (a right password, or no verify ran) in the
   * window it was reserved in, never below zero; a refund for a window that
   * expired changes nothing, so it never frees a place of the next window.
   */
  refund(stationDbId: string, window: number): Promise<void>;
  /** Frees a slow check no verify used, only while `token` still holds it. */
  giveBack(stationDbId: string, addressKey: string, token: string): Promise<void>;
}

/**
 * The client address part of the slow check key: an IPv4 address as is, an
 * IPv6 address by its /48 (one allocation must not open a slow check per /64),
 * `unknown` without one. The per-address lockouts keep the /64 key.
 */
export function stationAddressKey(clientIp: string | null): string {
  return clientIp == null ? 'unknown' : clientAddressKey(clientIp, 48);
}

/** The HMAC key of the shared known-good digests, derived from the settings key. */
export function knownGoodKeyFrom(secret: string): Buffer {
  return deriveKey(secret, KEY_LABELS.stationKnownGood);
}

function knownGoodDigest(
  key: Buffer,
  stationDbId: string,
  storedHash: string,
  password: string,
): string {
  return createHmac('sha256', key)
    .update(stationDbId)
    .update('\0')
    .update(storedHash)
    .update('\0')
    .update(password)
    .digest('hex');
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
  private readonly ipBackoff: StationAuthBackoff | null;
  private readonly stationWideBackoff: StationAuthBackoff | null;
  private readonly storeTimeoutMs: number;
  // The argon2 verify in flight per station database id.
  private readonly inFlight = new Map<string, Promise<boolean>>();
  // Waiting checks per stationAuthBackoffKey (station and client address).
  private readonly waiters = new Map<string, number>();
  private readonly maxWaiters: number;
  private readonly maxWaitMs: number;
  // Slow lane: next allowed verify per locked-out address (`ip|<key>`) and per
  // station past its station-wide budget (`station|<db id>`), and the slow-lane
  // verifies running now.
  private readonly slowNextAt = new Map<string, number>();
  private slowActive = 0;
  private readonly slowIntervalMs: number;
  private readonly slowMaxActive: number;
  private store: { store: KnownGoodStore; key: Buffer } | null = null;
  private attemptStore: StationAttemptStore | null = null;
  private readonly stationSlowIntervalMs: number;
  private readonly logger: { warn: (obj: unknown, msg: string) => void } | null;
  private lastFallbackLogAt = 0;
  // When this process last refreshed each held station's known-good record.
  private knownGoodTouchedAt = new Map<string, number>();
  private readonly gate: Gate;
  private readonly maxPendingRehashes: number;
  private readonly pendingRehashes = new Map<string, () => Promise<void>>();
  private rehashLane: Promise<void> | null = null;

  constructor(options: StationPasswordVerifierOptions = {}) {
    this.cache = options.cache ?? null;
    this.backoff = options.backoff === undefined ? new StationAuthBackoff() : options.backoff;
    this.ipBackoff =
      options.ipBackoff !== undefined
        ? options.ipBackoff
        : this.backoff == null
          ? null
          : new StationAuthBackoff({ limit: IP_AUTH_FAILURE_LIMIT });
    this.stationWideBackoff =
      options.stationWideBackoff !== undefined
        ? options.stationWideBackoff
        : this.backoff == null
          ? null
          : new StationAuthBackoff({ limit: STATION_WIDE_FAILURE_LIMIT });
    this.storeTimeoutMs = Math.max(
      0,
      options.knownGoodStoreTimeoutMs ?? KNOWN_GOOD_STORE_TIMEOUT_MS,
    );
    this.gate = new Gate(Math.max(1, options.maxConcurrent ?? defaultArgon2Concurrency()));
    this.maxPendingRehashes = Math.max(1, options.maxPendingRehashes ?? STATION_REHASH_MAX_PENDING);
    this.maxWaiters = Math.max(0, options.maxWaiters ?? STATION_AUTH_MAX_WAITERS);
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? STATION_AUTH_MAX_WAIT_MS);
    this.slowIntervalMs = Math.max(0, options.slowLaneIntervalMs ?? SLOW_LANE_INTERVAL_MS);
    this.slowMaxActive = Math.max(1, options.slowLaneMaxActive ?? SLOW_LANE_MAX_ACTIVE);
    this.stationSlowIntervalMs = Math.max(
      0,
      options.stationSlowCheckIntervalMs ?? STATION_SLOW_CHECK_INTERVAL_MS,
    );
    this.logger = options.logger ?? null;
  }

  /** Shares known-good credentials through `store` (Redis in production). */
  useKnownGoodStore(store: KnownGoodStore, key: Buffer): void {
    this.store = { store, key };
  }

  /** Shares the station check budget and slow check through `store` (Redis in production). */
  useStationAttemptStore(store: StationAttemptStore): void {
    this.attemptStore = store;
  }

  /**
   * Keeps the known-good records of the stations this process holds fresh, so
   * a station that stays connected keeps its record past
   * STATION_RECENT_SUCCESS_MS and reconnects at once, also during a flood on
   * its id. Each station at most once per KNOWN_GOOD_REFRESH_INTERVAL_MS, in
   * one store call; only records that exist move. Not awaited by the caller:
   * the store logs its own failures.
   */
  refreshKnownGood(stationDbIds: readonly string[]): Promise<void> {
    if (this.store == null) return Promise.resolve();
    const now = Date.now();
    const touched = new Map<string, number>();
    const due: string[] = [];
    for (const id of stationDbIds) {
      const last = this.knownGoodTouchedAt.get(id);
      if (last != null && now - last < KNOWN_GOOD_REFRESH_INTERVAL_MS) {
        touched.set(id, last);
      } else {
        touched.set(id, now);
        due.push(id);
      }
    }
    // Only the stations held now are tracked, so the map never outgrows them.
    this.knownGoodTouchedAt = touched;
    if (due.length === 0) return Promise.resolve();
    return this.store.store.touch(due, STATION_RECENT_SUCCESS_MS).catch(() => {
      // fail-open: the store logs its own failure; the next cycle after the
      // interval tries again, and the record still ends no earlier than before.
    });
  }

  /**
   * Throws when the stored hash cannot be parsed (argon2 error). The cache is
   * checked before the lockout, so a flood of wrong passwords on a station id
   * never locks out the station that holds the right one.
   */
  async verify(
    stationDbId: string,
    storedHash: string,
    password: string,
    clientIp: string | null,
    stationId?: string,
  ): Promise<PasswordCheck> {
    // Step 1: a known-good credential, proven for this stored hash on this
    // process (cache, recent-success digest) or on any process (the shared
    // store), is accepted at once: no argon2, no wait, no lockout. Nothing
    // else is trusted: not an address, not a header.
    if (this.isKnownGood(stationDbId, storedHash, password)) return { valid: true, cached: true };
    if (await this.isSharedKnownGood(stationDbId, storedHash, password)) {
      this.cache?.remember(stationDbId, storedHash, password, stationId);
      return { valid: true, cached: true };
    }
    const backoffKey = stationAuthBackoffKey(stationDbId, clientIp);
    if ((this.backoff?.lockedForMs(backoffKey) ?? 0) > 0) {
      return { valid: false, cached: false, lockedForMs: this.backoff?.lockedForMs(backoffKey) };
    }
    const addressKey = stationAddressKey(clientIp);
    // One argon2 per station at a time, for every other caller: wait for the
    // one in flight, then decide again (it may have proven this password, or
    // the failures it counted may lock the caller out). The waiters are capped
    // per client address and the wait is bounded; past either, retry later.
    // Step 2 runs after the wait: the station's failure budget, shared by every
    // process. Within it the check reserves one place in the same atomic step
    // that reads the count, so a parallel burst never passes the budget; a
    // right password refunds it. Past it, the one check that takes the slow
    // check of its station and address verifies and every other check of that
    // pair waits. Null when no shared store answered: the local counters below
    // decide instead. A check that finds another verify in flight after the
    // take gives back what it took and waits again. The loop runs here, not in a
    // helper: the last in-flight check and the set below must run without an
    // await between them.
    const deadline = Date.now() + this.maxWaitMs;
    let shared: StationCheckTake | null;
    for (;;) {
      for (let running = this.inFlight.get(stationDbId); running != null; ) {
        if (!(await this.waitOnce(backoffKey, running, deadline))) {
          return { valid: false, cached: false, lockedForMs: STATION_AUTH_BUSY_RETRY_MS };
        }
        if (this.isKnownGood(stationDbId, storedHash, password)) {
          return { valid: true, cached: true };
        }
        running = this.inFlight.get(stationDbId);
      }
      shared = await this.takeSharedCheck(stationDbId, addressKey);
      if (shared?.kind === 'wait') {
        return { valid: false, cached: false, lockedForMs: Math.max(1, shared.retryMs) };
      }
      if (!this.inFlight.has(stationDbId)) break;
      this.giveBackSharedCheck(stationDbId, addressKey, shared);
    }
    const taken = shared;
    const giveBack = (): void => {
      this.giveBackSharedCheck(stationDbId, addressKey, taken);
    };
    const stationLockedForMs = this.backoff?.lockedForMs(backoffKey) ?? 0;
    if (stationLockedForMs > 0) {
      giveBack();
      return { valid: false, cached: false, lockedForMs: stationLockedForMs };
    }
    const ipKey = clientIp == null ? null : clientAddressKey(clientIp);
    // Step 3: a bounded slow lane, not a flat refusal, for a locked-out
    // address (one full verify per SLOW_LANE_INTERVAL_MS per address) and for
    // a station past its budget when the shared store did not answer (one per
    // STATION_SLOW_CHECK_INTERVAL_MS per station and address, this process
    // only). At most SLOW_LANE_MAX_ACTIVE slow verifies run at once per
    // process. A valid
    // password is accepted and becomes known good; a wrong one counts against
    // station and address.
    const slowKeys: { key: string; intervalMs: number }[] = [];
    if (ipKey != null && (this.ipBackoff?.lockedForMs(ipKey) ?? 0) > 0) {
      slowKeys.push({ key: `ip|${ipKey}`, intervalMs: this.slowIntervalMs });
    }
    if (taken == null && (this.stationWideBackoff?.lockedForMs(stationDbId) ?? 0) > 0) {
      slowKeys.push({
        key: `station|${stationDbId}|${addressKey}`,
        intervalMs: this.stationSlowIntervalMs,
      });
    }
    const slow = slowKeys.length > 0 || taken?.kind === 'slow';
    if (slow) {
      const now = Date.now();
      const waitMs = Math.max(0, ...slowKeys.map((k) => (this.slowNextAt.get(k.key) ?? 0) - now));
      if (waitMs > 0) {
        giveBack();
        return { valid: false, cached: false, lockedForMs: waitMs };
      }
      if (this.slowActive >= this.slowMaxActive) {
        giveBack();
        return { valid: false, cached: false, lockedForMs: this.slowIntervalMs };
      }
      for (const k of slowKeys) {
        this.slowNextAt.delete(k.key);
        this.slowNextAt.set(k.key, now + k.intervalMs);
      }
      while (this.slowNextAt.size > SLOW_LANE_MAX_ENTRIES) {
        const oldest = this.slowNextAt.keys().next().value;
        if (oldest == null) break;
        this.slowNextAt.delete(oldest);
      }
      this.slowActive++;
    }
    // No await between the checks above and this set: the next caller for the
    // station sees this verify in flight.
    const running = this.gate.run(() => verify(storedHash, password));
    this.inFlight.set(stationDbId, running);
    let valid: boolean;
    try {
      valid = await running;
    } finally {
      if (this.inFlight.get(stationDbId) === running) this.inFlight.delete(stationDbId);
      if (slow) this.slowActive--;
    }
    if (valid) {
      this.cache?.remember(stationDbId, storedHash, password, stationId);
      this.backoff?.recordSuccess(backoffKey);
      // A right password is not a guess: its reserved place goes back.
      if (taken?.kind === 'counted') this.giveBackSharedCheck(stationDbId, addressKey, taken);
      // Not awaited: a slow store never delays the accepted check.
      void this.shareKnownGood(stationDbId, storedHash, password);
      // A success never clears the address count: one known password must not
      // reset the guesses at other stations from the same address.
    } else {
      this.backoff?.recordFailure(backoffKey);
      // The shared budget kept the place this check reserved; locally the
      // failure is counted now.
      if (taken == null) this.stationWideBackoff?.recordFailure(stationDbId);
      if (ipKey != null) this.ipBackoff?.recordFailure(ipKey);
    }
    return { valid, cached: false };
  }

  /**
   * One check of the station's shared budget, or null without a store, when
   * the store fails or does not answer within the store timeout (logged, at
   * most once a minute): the local counters decide then. A take that answers
   * after the timeout gives back the place or the slow check it took, so a
   * late reply never leaves anything held that no verify uses.
   */
  private async takeSharedCheck(
    stationDbId: string,
    addressKey: string,
  ): Promise<StationCheckTake | null> {
    const store = this.attemptStore;
    if (store == null || this.stationWideBackoff == null) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.storeTimeoutMs);
    });
    try {
      const pending = store.take(
        stationDbId,
        addressKey,
        STATION_WIDE_FAILURE_LIMIT,
        STATION_WIDE_WINDOW_MS,
        this.stationSlowIntervalMs,
        randomUUID(),
      );
      const taken = await Promise.race([pending, timeout]);
      if (taken !== 'timeout') return taken;
      this.logFallback(stationDbId, null);
      void pending.then(
        (late) => {
          this.giveBackSharedCheck(stationDbId, addressKey, late);
        },
        () => {
          // fail-open: a take that failed after the timeout holds nothing.
        },
      );
      return null;
    } catch (err: unknown) {
      this.logFallback(stationDbId, err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gives back what a check took and did not use as a failure: a reserved
   * place (refund), or a slow check (its token makes sure it is still this
   * check's).
   */
  private giveBackSharedCheck(
    stationDbId: string,
    addressKey: string,
    taken: StationCheckTake | null,
  ): void {
    const store = this.attemptStore;
    if (store == null || taken == null || taken.kind === 'wait') return;
    const back =
      taken.kind === 'counted'
        ? store.refund(stationDbId, taken.window)
        : store.giveBack(stationDbId, addressKey, taken.token);
    void back.catch((err: unknown) => {
      // fail-open: a lost refund costs the station one place of its budget for
      // the rest of the window; a lost give-back holds this address's slow
      // check for the rest of its interval.
      this.logFallback(stationDbId, err);
    });
  }

  private logFallback(stationDbId: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastFallbackLogAt < ATTEMPT_STORE_FALLBACK_LOG_MS) return;
    this.lastFallbackLogAt = now;
    this.logger?.warn(
      { err, stationDbId },
      'Shared station check budget unavailable; this process counts station checks locally',
    );
  }

  private async isSharedKnownGood(
    stationDbId: string,
    storedHash: string,
    password: string,
  ): Promise<boolean> {
    if (this.store == null) return false;
    const stored = await this.readStore(this.store.store, stationDbId);
    if (stored == null) return false;
    const expected = Buffer.from(
      knownGoodDigest(this.store.key, stationDbId, storedHash, password),
      'hex',
    );
    const actual = Buffer.from(stored, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** The store's value, or null on a miss, an error, or no answer within the timeout. */
  private async readStore(store: KnownGoodStore, stationDbId: string): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, this.storeTimeoutMs);
    });
    try {
      const read = store.get(stationDbId).catch(() => {
        // fail-open: a failed read is a miss; argon2 runs.
        return null;
      });
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private shareKnownGood(stationDbId: string, storedHash: string, password: string): Promise<void> {
    if (this.store == null) return Promise.resolve();
    return this.store.store
      .set(
        stationDbId,
        knownGoodDigest(this.store.key, stationDbId, storedHash, password),
        STATION_RECENT_SUCCESS_MS,
      )
      .catch(() => {
        // fail-open: the store logs its own failures; a lost write only costs
        // the next process one argon2.
      });
  }

  private isKnownGood(stationDbId: string, storedHash: string, password: string): boolean {
    if (this.cache == null) return false;
    return (
      this.cache.matches(stationDbId, storedHash, password) ||
      this.cache.matchesKnownGood(stationDbId, storedHash, password)
    );
  }

  /**
   * Waits for one verify in flight of the station. False when the waiters of
   * this station and client address are full or the deadline passed first.
   */
  private async waitOnce(
    waiterKey: string,
    running: Promise<boolean>,
    deadline: number,
  ): Promise<boolean> {
    const waiting = this.waiters.get(waiterKey) ?? 0;
    if (waiting >= this.maxWaiters) return false;
    this.waiters.set(waiterKey, waiting + 1);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        running.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => {
              resolve(false);
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      const left = (this.waiters.get(waiterKey) ?? 1) - 1;
      if (left <= 0) this.waiters.delete(waiterKey);
      else this.waiters.set(waiterKey, left);
    }
  }

  /**
   * True when this station identity and password succeeded within the cache
   * TTL. Read before the station lookup, so a station that holds its password
   * is not queued behind other authentications; the full check still runs.
   */
  hasCachedSuccess(stationId: string, password: string): boolean {
    return this.cache?.matchesPresented(stationId, password) === true;
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
  async remember(stationDbId: string, storedHash: string, password: string): Promise<void> {
    this.cache?.remember(stationDbId, storedHash, password);
    await this.shareKnownGood(stationDbId, storedHash, password);
  }

  invalidate(stationDbId: string): void {
    this.cache?.invalidate(stationDbId);
    // The digest holds the stored hash, so a new password never matches it;
    // the delete only frees the key early. The store logs its own failure.
    void this.store?.store.delete(stationDbId);
  }

  stats(): StationPasswordVerifierStats {
    return {
      cacheEntries: this.cache?.size ?? 0,
      argon2Running: this.gate.running,
      argon2Queued: this.gate.queued,
      argon2MaxConcurrent: this.gate.maxConcurrent,
      rehashPending: this.pendingRehashes.size,
      backoffEntries: (this.backoff?.size ?? 0) + (this.ipBackoff?.size ?? 0),
    };
  }
}
