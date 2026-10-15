// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { createRedisClient, isNonPublicAddress } from '@evtivity/lib';
import { config } from './config.js';

/**
 * Velocity limits on guest starts against card testing, on top of the
 * per-route rate limit (5 a minute per IP) and reCAPTCHA. Shared Redis
 * counters in fixed one-hour windows, so every API pod counts the same window:
 *
 * - every guest start per client IP (`guest:vl:start:<ip>:<window>`);
 * - every declined guest hold per client IP (`guest:vl:decline:<ip>:<window>`),
 *   checked before a new hold is placed.
 *
 * Per IP only: the guest card is a one-time payment method and no provider
 * returns a card fingerprint to the CSMS before the hold.
 *
 * The limits are operator settings (`guest.startsPerIpPerHour`,
 * `guest.declinesPerIpPerHour`, 0 means no limit), and apply only when the
 * real client IP is known (`guestVelocityClientIp`): behind an unconfigured
 * proxy every guest would share the proxy's address.
 *
 * A Redis failure allows the start (logged, fail-open): the route rate limit,
 * reCAPTCHA and the provider's own fraud checks still apply.
 */

const WINDOW_SECONDS = 60 * 60;

/**
 * Prefix of the counter keys. The api Redis user must hold `~guest:vl:*`
 * (Redis ACL rules), or every counter fails with NOPERM and the limits never apply.
 */
export const GUEST_VELOCITY_KEY_PREFIX = 'guest:vl:';

export interface GuestVelocityStore {
  /** Increments a key and returns the new count; the key expires after the window. */
  increment(key: string, windowSeconds: number): Promise<number>;
  /** The current count of a key (0 when absent). */
  read(key: string): Promise<number>;
}

let redis: Redis | null = null;

function redisClient(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'guest-velocity', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

const redisStore: GuestVelocityStore = {
  async increment(key, windowSeconds) {
    // MULTI INCR + EXPIRE NX: the first hit of a window sets its expiry.
    const result = await redisClient().multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    const [err, count] = result?.[0] ?? [new Error('Redis transaction was discarded'), null];
    if (err != null) throw err;
    if (typeof count !== 'number') throw new Error('Redis INCR returned no count');
    return count;
  },
  async read(key) {
    const value = await redisClient().get(key);
    const n = value == null ? 0 : Number(value);
    return Number.isFinite(n) ? n : 0;
  },
};

let store: GuestVelocityStore = redisStore;

/** Tests replace the store; null restores Redis. */
export function setGuestVelocityStore(next: GuestVelocityStore | null): void {
  store = next ?? redisStore;
}

function windowKey(kind: 'start' | 'decline', ip: string, nowMs: number): string {
  return `${GUEST_VELOCITY_KEY_PREFIX}${kind}:${ip}:${String(Math.floor(nowMs / 1000 / WINDOW_SECONDS))}`;
}

function secondsToWindowEnd(nowMs: number): number {
  return WINDOW_SECONDS - (Math.floor(nowMs / 1000) % WINDOW_SECONDS);
}

export type GuestVelocityRefusal = { retryAfterSeconds: number } | null;

/**
 * Whether `ip` is the real client address: TRUST_PROXY is set (the address
 * comes through the trusted proxy chain), or it is unset and the socket
 * address is public. A private, loopback, link-local or unique-local socket
 * address without TRUST_PROXY is a proxy or a local network, shared by every
 * guest behind it.
 */
export function isClientIpKnown(ip: string, trustProxy: false | string): boolean {
  if (trustProxy !== false) return true;
  return !isNonPublicAddress(ip);
}

let loggedUnknownIp = false;

/**
 * The address the per-IP limits count, or null when the real client IP is
 * not known: then both limits are off and reCAPTCHA and the QR scan token
 * remain (logged at debug once per process).
 */
export function guestVelocityClientIp(
  request: Pick<FastifyRequest, 'ip' | 'log'>,
  trustProxy: false | string = config.TRUST_PROXY,
): string | null {
  if (isClientIpKnown(request.ip, trustProxy)) return request.ip;
  if (!loggedUnknownIp) {
    loggedUnknownIp = true;
    request.log.debug(
      'Guest per-IP limits are off: the client IP is not known (no TRUST_PROXY and a non-public socket address)',
    );
  }
  return null;
}

/**
 * Counts one guest start of the IP. Returns a refusal when the IP made more
 * than `limit` starts this hour. A null IP (not known) or a limit of 0 counts
 * nothing.
 */
export async function countGuestStart(
  ip: string | null,
  limit: number,
  log: FastifyBaseLogger,
  nowMs: number = Date.now(),
): Promise<GuestVelocityRefusal> {
  if (ip == null || limit <= 0) return null;
  try {
    const count = await store.increment(windowKey('start', ip, nowMs), WINDOW_SECONDS);
    if (count > limit) {
      return { retryAfterSeconds: secondsToWindowEnd(nowMs) };
    }
    return null;
  } catch (err) {
    log.warn({ err }, 'Guest start velocity counter failed, allowing the start');
    return null;
  }
}

/**
 * Returns a refusal when the IP had `limit` declined guest holds this hour,
 * so no further card is tried from it. A null IP or a limit of 0 never refuses.
 */
export async function checkGuestDeclines(
  ip: string | null,
  limit: number,
  log: FastifyBaseLogger,
  nowMs: number = Date.now(),
): Promise<GuestVelocityRefusal> {
  if (ip == null || limit <= 0) return null;
  try {
    const count = await store.read(windowKey('decline', ip, nowMs));
    if (count >= limit) {
      return { retryAfterSeconds: secondsToWindowEnd(nowMs) };
    }
    return null;
  } catch (err) {
    log.warn({ err }, 'Guest decline velocity read failed, allowing the hold');
    return null;
  }
}

/** Counts one declined guest hold of the IP (nothing for a null IP). Fail-open (logged). */
export async function countGuestDecline(
  ip: string | null,
  log: FastifyBaseLogger,
  nowMs: number = Date.now(),
): Promise<void> {
  if (ip == null) return;
  try {
    await store.increment(windowKey('decline', ip, nowMs), WINDOW_SECONDS);
  } catch (err) {
    log.warn({ err }, 'Guest decline velocity counter failed');
  }
}
