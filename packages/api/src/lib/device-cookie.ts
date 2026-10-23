// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { db, driverAuditLog, signInDevices, userAuditLog, writeAudit } from '@evtivity/database';
import type { MfaAccount } from '../services/mfa-factor.service.js';
import { isSecureRequest, readSignedCookie } from './auth-cookies.js';
import { authRequestOrigin } from './auth-audit.js';
import { lockValues, SIGN_IN_FREE_FAILURES } from './sign-in-backoff.js';

/**
 * Sign-in device cookies (OWASP "Slow down online guessing attacks with device
 * cookies"). A browser that fully
 * signed in to an account (password and, when the account has one, the MFA step)
 * holds a signed, HttpOnly cookie for it. Its password tries count on its own row
 * (`sign_in_devices`), with the account backoff rule, and skip the account lock: a
 * stranger's wrong guesses lock the account for other clients but not the owner's
 * browser, and a wrong guess from that browser locks only its cookie. The device
 * failures of an account share a ceiling: past it the account lock applies to
 * every browser again, so device cookies slow a lock but never disable it.
 */
export type DeviceRealm = 'csms' | 'portal';

// The cookie reaches the sign-in routes only: password, MFA and passkey steps.
const DEVICE_COOKIES: Record<DeviceRealm, { name: string; path: string }> = {
  csms: { name: 'csms_device', path: '/v1/auth' },
  portal: { name: 'portal_device', path: '/v1/portal/auth' },
};

/** A device cookie lives 180 days from the last sign-in that set or refreshed it. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** Device rows an account keeps; a new sign-in device evicts the oldest. */
export const MAX_SIGN_IN_DEVICES = 10;

/** Device failures of an account (all its devices) past which the account lock applies to them. */
export const DEVICE_FAILURE_CEILING = 20;

export interface SignInDevice {
  id: number;
}

const hashOf = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

function ownerOf(account: MfaAccount) {
  return 'userId' in account
    ? eq(signInDevices.userId, account.userId)
    : eq(signInDevices.driverId, account.driverId);
}

/** The device row of this browser's cookie for the account, or null. */
async function deviceOfCookie(
  request: FastifyRequest,
  realm: DeviceRealm,
  account: MfaAccount,
): Promise<SignInDevice | null> {
  const cookie = readSignedCookie(request, DEVICE_COOKIES[realm].name);
  if (cookie.status !== 'valid') return null;
  const [row] = await db
    .select({ id: signInDevices.id })
    .from(signInDevices)
    .where(and(eq(signInDevices.tokenHash, hashOf(cookie.value)), ownerOf(account)));
  return row ?? null;
}

/**
 * The device of this browser for a password sign-in, or null: no cookie, a bad
 * signature, another account, or the account's devices past the failure ceiling.
 */
export async function knownSignInDevice(
  request: FastifyRequest,
  realm: DeviceRealm,
  account: MfaAccount,
): Promise<SignInDevice | null> {
  const device = await deviceOfCookie(request, realm, account);
  if (device == null) return null;
  const [sum] = await db
    .select({ failures: sql<number>`coalesce(sum(${signInDevices.failedCount}), 0)::int` })
    .from(signInDevices)
    .where(ownerOf(account));
  return (sum?.failures ?? 0) >= DEVICE_FAILURE_CEILING ? null : device;
}

export interface DeviceAttempt {
  granted: boolean;
  failures: number;
  lockedUntil: Date | null;
}

/**
 * Takes one try on the device's counter before the password is checked, in the
 * UPDATE that checks its lock (parallel guesses cannot pass it).
 */
export async function takeDeviceAttempt(device: SignInDevice): Promise<DeviceAttempt> {
  const v = lockValues(signInDevices.failedCount, signInDevices.lockedUntil);
  const [row] = await db
    .update(signInDevices)
    .set({ failedCount: v.count, lockedUntil: v.until })
    .where(
      and(
        eq(signInDevices.id, device.id),
        sql`(${signInDevices.lockedUntil} IS NULL OR ${signInDevices.lockedUntil} <= now())`,
      ),
    )
    .returning({ failures: signInDevices.failedCount, lockedUntil: signInDevices.lockedUntil });
  return row == null
    ? { granted: false, failures: 0, lockedUntil: null }
    : { granted: true, failures: row.failures, lockedUntil: row.lockedUntil };
}

/** After a wrong password from a device: audits the lock its count set (`account_locked`, factor `device`). */
export async function recordDeviceFailure(
  request: FastifyRequest,
  account: MfaAccount,
  attempt: DeviceAttempt,
): Promise<void> {
  if (attempt.failures < SIGN_IN_FREE_FAILURES || attempt.lockedUntil == null) return;
  const accountId = 'userId' in account ? account.userId : account.driverId;
  await writeAudit(
    'userId' in account
      ? { table: userAuditLog, idColumn: 'user_id' }
      : { table: driverAuditLog, idColumn: 'driver_id' },
    {
      entityId: accountId,
      entityIdSnapshot: accountId,
      action: 'account_locked',
      actor: 'system',
      actorLabel: 'login',
      after: {
        factor: 'device',
        failures: attempt.failures,
        lockedUntil: attempt.lockedUntil.toISOString(),
        ...authRequestOrigin(request),
      },
      notes: 'Password sign-in of a known device locked',
    },
    db,
    request.log,
  );
}

/** A right password from the device: its count starts again. */
export async function clearDeviceFailures(device: SignInDevice): Promise<void> {
  await db
    .update(signInDevices)
    .set({ failedCount: 0, lockedUntil: null })
    .where(eq(signInDevices.id, device.id));
}

/**
 * After a full sign-in (the session is issued): refreshes this browser's device, or
 * gives it one and evicts the account's oldest devices past MAX_SIGN_IN_DEVICES.
 */
export async function rememberSignInDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  realm: DeviceRealm,
  account: MfaAccount,
): Promise<void> {
  const known = await deviceOfCookie(request, realm, account);
  if (known != null) {
    await db
      .update(signInDevices)
      .set({ failedCount: 0, lockedUntil: null, lastUsedAt: new Date() })
      .where(eq(signInDevices.id, known.id));
    return;
  }
  const raw = crypto.randomBytes(32).toString('base64url');
  await db.insert(signInDevices).values({
    ...('userId' in account ? { userId: account.userId } : { driverId: account.driverId }),
    tokenHash: hashOf(raw),
  });
  const keep = await db
    .select({ id: signInDevices.id })
    .from(signInDevices)
    .where(ownerOf(account))
    .orderBy(desc(signInDevices.lastUsedAt), desc(signInDevices.id))
    .limit(MAX_SIGN_IN_DEVICES);
  await db.delete(signInDevices).where(
    and(
      ownerOf(account),
      notInArray(
        signInDevices.id,
        keep.map((r) => r.id),
      ),
    ),
  );
  const cfg = DEVICE_COOKIES[realm];
  void reply.setCookie(cfg.name, raw, {
    httpOnly: true,
    secure: isSecureRequest(request),
    signed: true,
    sameSite: 'strict',
    path: cfg.path,
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * Forgets every sign-in device of the accounts: a password change or reset, the end
 * of every session, a deactivation, an MFA reset or an erasure. The lockout-exempt
 * credential never outlives them.
 */
export async function revokeSignInDevices(account: MfaAccount): Promise<void> {
  await db.delete(signInDevices).where(ownerOf(account));
}
