// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, count, eq, gte } from 'drizzle-orm';
import { db, drivers, userTokens } from '@evtivity/database';
import { normalizeE164 } from '@evtivity/lib';

/**
 * Per-account and per-contact limits on driver sign-up, on top of the per-IP route rate limits.
 * They need no table of their own: the counts come from `user_tokens` and `drivers` rows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most one verification email per minute per driver. */
export const VERIFICATION_RESEND_INTERVAL_SECONDS = 60;
/** At most this many verification emails (the sign-up one included) per driver in 24 hours. */
export const VERIFICATION_EMAILS_PER_DAY = 5;
/**
 * At most this many portal registrations with one phone number in 24 hours. An existing driver
 * with the same phone does not block a registration: families share a phone.
 */
export const PHONE_REGISTRATIONS_PER_DAY = 3;

/** The phone as stored on a portal registration, or null for none. */
export function registrationPhone(phone: string | undefined): string | null {
  if (phone == null) return null;
  const normalized = normalizeE164(phone.trim());
  return normalized === '' ? null : normalized;
}

/** True when the phone was used in too many portal registrations in the last 24 hours. */
export async function isPhoneRegistrationLimited(
  phone: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(drivers)
    .where(
      and(
        eq(drivers.phone, phone),
        eq(drivers.registrationSource, 'portal'),
        gte(drivers.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return (row?.n ?? 0) >= PHONE_REGISTRATIONS_PER_DAY;
}

/**
 * Seconds until the driver may get another verification email, or null when one may go now.
 * Counts the driver's email_verification tokens of the last 24 hours (revoked ones included:
 * a resend revokes the previous link but each one was an email).
 */
export async function verificationResendRetryAfter(
  driverId: string,
  now = new Date(),
): Promise<number | null> {
  const rows = await db
    .select({ createdAt: userTokens.createdAt })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.driverId, driverId),
        eq(userTokens.type, 'email_verification'),
        gte(userTokens.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .orderBy(asc(userTokens.createdAt));
  if (rows.length === 0) return null;

  const waits: number[] = [];
  const newest = rows[rows.length - 1];
  if (newest != null) {
    const nextAt = newest.createdAt.getTime() + VERIFICATION_RESEND_INTERVAL_SECONDS * 1000;
    if (nextAt > now.getTime()) waits.push(nextAt - now.getTime());
  }
  if (rows.length >= VERIFICATION_EMAILS_PER_DAY) {
    // The window frees a slot when its oldest email is 24 hours old.
    const freeing = rows[rows.length - VERIFICATION_EMAILS_PER_DAY];
    if (freeing != null) waits.push(freeing.createdAt.getTime() + DAY_MS - now.getTime());
  }
  if (waits.length === 0) return null;
  return Math.max(1, Math.ceil(Math.max(...waits) / 1000));
}
