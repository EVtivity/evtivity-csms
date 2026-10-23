// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';
import type { Logger } from '@evtivity/lib';
import type {
  KnownGoodStore,
  StationAttemptStore,
  StationCheckTake,
} from './station-password-verifier.js';

/** Redis key prefix of the shared known-good station credentials (ocpp ACL `~ocpp:auth:*`). */
export const KNOWN_GOOD_KEY_PREFIX = 'ocpp:auth:ok:';
/**
 * Redis key prefix of the shared station failure budget (wrong passwords per
 * fixed window): `<prefix><station db id>:<window>`, the window being
 * `floor(now / windowMs)`.
 */
export const STATION_CHECKS_KEY_PREFIX = 'ocpp:auth:fail:';
/**
 * Redis key prefix of the shared slow checks, one per station and client
 * address key (`<prefix><station db id>:<address key>`), each held for one
 * interval under the token of the check that took it.
 */
export const STATION_SLOW_KEY_PREFIX = 'ocpp:auth:slow:';

/**
 * Known-good station credentials in Redis, shared by every OCPP process, so a
 * station that proved its password once connects at once on every pod.
 * Each failure is logged and treated as a miss, so a Redis outage only means
 * the full password check runs, as without the store.
 */
export function createRedisKnownGoodStore(redis: Redis, logger: Logger): KnownGoodStore {
  const keyOf = (stationDbId: string): string => `${KNOWN_GOOD_KEY_PREFIX}${stationDbId}`;
  return {
    async get(stationDbId) {
      try {
        return await redis.get(keyOf(stationDbId));
      } catch (err) {
        logger.warn({ err, stationDbId }, 'Known-good station credential read failed');
        return null;
      }
    },
    async set(stationDbId, digest, ttlMs) {
      try {
        await redis.set(keyOf(stationDbId), digest, 'PX', ttlMs);
      } catch (err) {
        logger.warn({ err, stationDbId }, 'Known-good station credential write failed');
      }
    },
    async delete(stationDbId) {
      try {
        await redis.del(keyOf(stationDbId));
      } catch (err) {
        logger.warn({ err, stationDbId }, 'Known-good station credential delete failed');
      }
    },
    async touch(stationDbIds, ttlMs) {
      if (stationDbIds.length === 0) return;
      try {
        // PEXPIRE moves the expiry of an existing key only; a missing key
        // stays missing, so no record is ever created here.
        const pipeline = redis.pipeline();
        for (const id of stationDbIds) pipeline.pexpire(keyOf(id), ttlMs);
        await pipeline.exec();
      } catch (err) {
        logger.warn(
          { err, stations: stationDbIds.length },
          'Known-good station credential refresh failed',
        );
      }
    },
  };
}

// One atomic step: within the budget the check reserves one place (INCR in
// the same step that reads the count) in the key of the current fixed window
// and returns that window, so parallel checks never pass it; past it, the slow
// check of the station and address is taken under the check's token when
// free, else its remaining time is returned. The window key lives two windows,
// so a refund that arrives just after the window ended still finds it.
const TAKE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count < tonumber(ARGV[1]) then
  if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
  return {1, tonumber(ARGV[5])}
end
if redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[3], 'NX') then return {2, 0} end
return {3, redis.call('PTTL', KEYS[2])}
`;

// Refunds a reserved place in the window key it was reserved in, without
// going below zero or creating the key. A later window has its own key, so a
// refund for an expired window never frees one of its places.
const REFUND_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then redis.call('DECR', KEYS[1]) end
return 0
`;

// Compare and delete: frees the slow check only while this token holds it, so
// a late give-back never frees the slow check another check took since.
const GIVE_BACK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * The station failure budget and slow checks in Redis, shared by every OCPP
 * process, so one address gets one check a minute for a station past its
 * budget however many processes run. Errors are thrown: the verifier falls
 * back to its local counters and logs it.
 */
export function createRedisStationAttemptStore(redis: Redis): StationAttemptStore {
  const checksKey = (id: string, window: number): string =>
    `${STATION_CHECKS_KEY_PREFIX}${id}:${String(window)}`;
  const slowKey = (id: string, addressKey: string): string =>
    `${STATION_SLOW_KEY_PREFIX}${id}:${addressKey}`;
  return {
    async take(
      stationDbId,
      addressKey,
      limit,
      windowMs,
      slowIntervalMs,
      token,
    ): Promise<StationCheckTake> {
      const window = Math.floor(Date.now() / windowMs);
      const [kind, value] = (await redis.eval(
        TAKE_SCRIPT,
        2,
        checksKey(stationDbId, window),
        slowKey(stationDbId, addressKey),
        String(limit),
        String(windowMs * 2),
        String(slowIntervalMs),
        token,
        String(window),
      )) as [number, number];
      if (kind === 1) return { kind: 'counted', window: value };
      if (kind === 2) return { kind: 'slow', token };
      return { kind: 'wait', retryMs: value > 0 ? value : slowIntervalMs };
    },
    async refund(stationDbId, window) {
      await redis.eval(REFUND_SCRIPT, 1, checksKey(stationDbId, window));
    },
    async giveBack(stationDbId, addressKey, token) {
      await redis.eval(GIVE_BACK_SCRIPT, 1, slowKey(stationDbId, addressKey), token);
    },
  };
}
