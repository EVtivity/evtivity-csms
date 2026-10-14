// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, driverTokens, userTokens } from '@evtivity/database';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { announceDriverDeactivated } from '../lib/driver-active.js';
import * as tokenService from './token.service.js';
import { revokeAllDriverRefreshTokens } from './refresh-token.service.js';

/**
 * The emailed single-use links of a driver: portal invitation, password
 * reset and email verification. Each one was addressed to the email the
 * driver had when it was sent.
 */
export const DRIVER_EMAIL_LINK_TYPES = [
  'portal_invite',
  'password_reset',
  'email_verification',
] as const;

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface DriverStatusContext {
  actor: AuditActorInfo;
  log: Logger;
}

/** The token service actor of a request actor (it records operators and drivers by id). */
function tokenActor(actor: AuditActorInfo): tokenService.TokenActor {
  if (actor.actorUserId != null) return { type: 'operator', userId: actor.actorUserId };
  if (actor.actorDriverId != null) return { type: 'driver', driverId: actor.actorDriverId };
  return { type: 'system' };
}

/**
 * Revokes the open emailed links of a driver. Called when the driver is
 * deactivated and when the email changes, so a link sent to the old address
 * can no longer set a password or verify the new address.
 */
export async function revokeDriverEmailLinks(driverId: string): Promise<void> {
  await db
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userTokens.driverId, driverId),
        inArray(userTokens.type, [...DRIVER_EMAIL_LINK_TYPES]),
        isNull(userTokens.revokedAt),
      ),
    );
}

/**
 * Applies a driver deactivation after `drivers.is_active` was set to false,
 * by PATCH /v1/drivers/:id or DELETE /v1/drivers/:id. Idempotent: a repeated
 * call finds nothing left to change.
 *
 * - Ends the driver's open portal streams on every API pod.
 * - Revokes every refresh token, so a reactivation does not bring old
 *   sessions back.
 * - Revokes the open emailed links (invitation, reset, verification).
 * - Deactivates every active token of the driver through the token service
 *   (audit, local auth list bump, driver notification). OCPP authorization
 *   reads the token status, so this is what stops RFID and app starts.
 *   Reactivating the driver does not reactivate the tokens: some may have
 *   been turned off on purpose (a lost card).
 *
 * Returns the number of tokens it deactivated.
 */
export async function applyDriverDeactivation(
  driverId: string,
  ctx: DriverStatusContext,
): Promise<{ tokensDeactivated: number }> {
  announceDriverDeactivated(driverId);

  try {
    await revokeAllDriverRefreshTokens(driverId);
    await revokeDriverEmailLinks(driverId);
  } catch (err) {
    // fail-open: the driver is already inactive, so every portal request,
    // refresh and emailed link is refused by its own status check (P9).
    ctx.log.warn({ err, driverId }, 'Revoking the sessions of a deactivated driver failed');
  }

  const activeTokens = await db
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(eq(driverTokens.driverId, driverId), eq(driverTokens.isActive, true)));
  if (activeTokens.length === 0) return { tokensDeactivated: 0 };
  const { updated } = await tokenService.bulkSetActive(
    activeTokens.map((t) => t.id),
    false,
    tokenActor(ctx.actor),
  );
  return { tokensDeactivated: updated };
}
