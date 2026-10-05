// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import argon2 from 'argon2';
import { and, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { AppError, dispatchSystemNotification } from '@evtivity/lib';
import { db, client, drivers, userTokens, driverAuditLog, writeAudit } from '@evtivity/database';
import { generateUserToken, hashUserToken } from '../lib/user-token.js';
import { validatePasswordComplexity } from '../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from '../lib/config.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { revokeAllDriverRefreshTokens } from './refresh-token.service.js';

// The only writer of `portal_invite` tokens and of the first password on a
// driver that has none. Operators grant portal access to operator-created
// drivers through an emailed, single-use invite. Public registration and
// password recovery never attach a password to a driver without one, so
// knowing a driver's email address is not enough to take over the record.

const PORTAL_INVITE = 'portal_invite';
const INVITE_TTL_DAYS = 7;
const AUDIT_TABLE = { table: driverAuditLog, idColumn: 'driver_id' };

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface PortalAccessContext {
  actor: AuditActorInfo;
  log: Logger;
}

export type PortalAccessStatus = 'active' | 'invited' | 'none';

const invalidToken = (): AppError =>
  new AppError('Invalid or expired invitation link', 400, 'INVALID_TOKEN');

export async function inviteDriverToPortal(
  driverId: string,
  ctx: PortalAccessContext,
): Promise<{ expiresAt: Date }> {
  const [driver] = await db
    .select({
      id: drivers.id,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      email: drivers.email,
      phone: drivers.phone,
      language: drivers.language,
      isActive: drivers.isActive,
      passwordHash: drivers.passwordHash,
    })
    .from(drivers)
    .where(eq(drivers.id, driverId));

  if (driver == null) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
  if (!driver.isActive) throw new AppError('Driver is inactive', 409, 'DRIVER_INACTIVE');
  if (driver.email == null || driver.email === '') {
    throw new AppError('Driver has no email address', 400, 'EMAIL_REQUIRED');
  }
  if (driver.passwordHash != null) {
    throw new AppError('Driver already has portal access', 409, 'PORTAL_ALREADY_ACTIVE');
  }

  const { raw, hash } = generateUserToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // A resend replaces the earlier link, so only the newest invite works.
  await db.transaction(async (tx) => {
    await tx
      .update(userTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userTokens.driverId, driver.id),
          eq(userTokens.type, PORTAL_INVITE),
          isNull(userTokens.revokedAt),
        ),
      );
    await tx.insert(userTokens).values({
      driverId: driver.id,
      tokenHash: hash,
      type: PORTAL_INVITE,
      expiresAt,
    });
  });

  try {
    await dispatchSystemNotification(
      client,
      'driver.PortalInvite',
      {
        email: driver.email,
        phone: driver.phone ?? undefined,
        firstName: driver.firstName,
        lastName: driver.lastName,
        language: driver.language,
      },
      {
        firstName: driver.firstName,
        lastName: driver.lastName,
        email: driver.email,
        activateUrl: `${config.PORTAL_URL}/activate?token=${raw}`,
        expiresInDays: INVITE_TTL_DAYS,
      },
      ALL_TEMPLATES_DIRS,
    );
  } catch (err) {
    ctx.log.warn({ err, driverId: driver.id }, 'Portal invite notification failed');
  }

  await writeAudit(
    AUDIT_TABLE,
    {
      entityId: driver.id,
      entityIdSnapshot: driver.id,
      action: 'portal_invited',
      ...ctx.actor,
      after: { inviteExpiresAt: expiresAt },
    },
    db,
    ctx.log,
  );

  return { expiresAt };
}

export async function activateDriverPortal(
  rawToken: string,
  password: string,
  log: Logger,
): Promise<void> {
  const complexityError = validatePasswordComplexity(password);
  if (complexityError != null) throw new AppError(complexityError, 400, 'WEAK_PASSWORD');

  // Hashed before the token lookup so a valid and an invalid token take the
  // same time.
  const passwordHash = await argon2.hash(password);
  const now = new Date();

  const driverId = await db.transaction(async (tx) => {
    // Consuming the token in the WHERE makes it single-use under concurrency.
    const [token] = await tx
      .update(userTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(userTokens.tokenHash, hashUserToken(rawToken)),
          eq(userTokens.type, PORTAL_INVITE),
          isNull(userTokens.revokedAt),
          gt(userTokens.expiresAt, now),
          isNotNull(userTokens.driverId),
        ),
      )
      .returning({ driverId: userTokens.driverId });
    if (token?.driverId == null) throw invalidToken();

    // Same error as a bad token, so the response does not reveal account state.
    const [driver] = await tx
      .update(drivers)
      .set({ passwordHash, emailVerified: true, updatedAt: now })
      .where(
        and(
          eq(drivers.id, token.driverId),
          isNull(drivers.passwordHash),
          eq(drivers.isActive, true),
        ),
      )
      .returning({ id: drivers.id });
    if (driver == null) throw invalidToken();

    await tx
      .update(userTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(userTokens.driverId, driver.id),
          eq(userTokens.type, PORTAL_INVITE),
          isNull(userTokens.revokedAt),
        ),
      );
    return driver.id;
  });

  // After the commit: a failed audit insert inside the transaction would abort it.
  await writeAudit(
    AUDIT_TABLE,
    {
      entityId: driverId,
      entityIdSnapshot: driverId,
      action: 'portal_activated',
      actor: 'driver',
      actorDriverId: driverId,
    },
    db,
    log,
  );
  await revokeAllDriverRefreshTokens(driverId);
}

export async function getPortalAccess(
  driverId: string,
): Promise<{ status: PortalAccessStatus; inviteExpiresAt: Date | null }> {
  const [driver] = await db
    .select({ passwordHash: drivers.passwordHash })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver?.passwordHash != null) return { status: 'active', inviteExpiresAt: null };

  const [invite] = await db
    .select({ expiresAt: userTokens.expiresAt })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.driverId, driverId),
        eq(userTokens.type, PORTAL_INVITE),
        isNull(userTokens.revokedAt),
        gt(userTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userTokens.expiresAt))
    .limit(1);
  return invite == null
    ? { status: 'none', inviteExpiresAt: null }
    : { status: 'invited', inviteExpiresAt: invite.expiresAt };
}
