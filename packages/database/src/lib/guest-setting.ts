// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, inArray } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('guest-setting');

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

/** Drop the cached value so the next read sees a just-saved setting. */
export function clearGuestChargingCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

export async function isGuestChargingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'guest.enabled'));

    cachedValue = row == null || row.value !== false;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: 'guest.enabled' },
      'isGuestChargingEnabled failed, using the cached value or default',
    );
    return cachedValue ?? true;
  }
}

export const GUEST_STARTS_PER_IP_PER_HOUR_KEY = 'guest.startsPerIpPerHour';
export const GUEST_DECLINES_PER_IP_PER_HOUR_KEY = 'guest.declinesPerIpPerHour';

/** Defaults when a limit is unset or invalid. */
export const DEFAULT_GUEST_STARTS_PER_IP_PER_HOUR = 30;
export const DEFAULT_GUEST_DECLINES_PER_IP_PER_HOUR = 5;

/** Highest limit an operator can store. */
export const MAX_GUEST_VELOCITY_LIMIT = 10_000;

/**
 * A stored per-IP guest limit when it is a whole number from 0 to
 * MAX_GUEST_VELOCITY_LIMIT, else null. 0 means no limit.
 */
export function parseGuestVelocityLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_GUEST_VELOCITY_LIMIT) return null;
  return value;
}

export interface GuestVelocityLimits {
  /** Guest starts one client IP may make per hour (0: no limit). */
  startsPerIpPerHour: number;
  /** Declined guest holds after which a client IP places no new hold this hour (0: no limit). */
  declinesPerIpPerHour: number;
}

const DEFAULT_LIMITS: GuestVelocityLimits = {
  startsPerIpPerHour: DEFAULT_GUEST_STARTS_PER_IP_PER_HOUR,
  declinesPerIpPerHour: DEFAULT_GUEST_DECLINES_PER_IP_PER_HOUR,
};

let cachedLimits: GuestVelocityLimits | undefined;
let limitsCachedAt = 0;

/**
 * The per-IP guest start and decline limits. 60 s cache; on a read error the
 * last value (or the defaults).
 */
export async function getGuestVelocityLimits(): Promise<GuestVelocityLimits> {
  const now = Date.now();
  if (cachedLimits !== undefined && now - limitsCachedAt < TTL_MS) return cachedLimits;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        inArray(settings.key, [
          GUEST_STARTS_PER_IP_PER_HOUR_KEY,
          GUEST_DECLINES_PER_IP_PER_HOUR_KEY,
        ]),
      );
    const valueOf = (key: string): unknown => rows.find((row) => row.key === key)?.value;
    cachedLimits = {
      startsPerIpPerHour:
        parseGuestVelocityLimit(valueOf(GUEST_STARTS_PER_IP_PER_HOUR_KEY)) ??
        DEFAULT_GUEST_STARTS_PER_IP_PER_HOUR,
      declinesPerIpPerHour:
        parseGuestVelocityLimit(valueOf(GUEST_DECLINES_PER_IP_PER_HOUR_KEY)) ??
        DEFAULT_GUEST_DECLINES_PER_IP_PER_HOUR,
    };
    limitsCachedAt = now;
    return cachedLimits;
  } catch (err) {
    logger.warn({ err }, 'getGuestVelocityLimits failed, using the cached value or defaults');
    return cachedLimits ?? DEFAULT_LIMITS;
  }
}

/** Drops the cached limits so the next read sees an operator change. */
export function clearGuestVelocityCache(): void {
  cachedLimits = undefined;
  limitsCachedAt = 0;
}
