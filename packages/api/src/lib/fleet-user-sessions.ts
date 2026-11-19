// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, userAuditLog, userFleetAssignments, writeAudit } from '@evtivity/database';
import type { AuditActorInfo } from './audit-actor.js';
import { endUserSessions } from './operator-session.js';
import { invalidateSiteAccessCache } from './site-access.js';
import { invalidatePermissionCache } from '../middleware/rbac.js';

/**
 * The fleet users assigned to a fleet, each with every fleet it is assigned
 * (sorted), read before the fleet is deleted: the delete cascades the
 * assignments away.
 */
export async function fleetUserAssignmentsOf(fleetId: string): Promise<Map<string, string[]>> {
  const assigned = db
    .select({ userId: userFleetAssignments.userId })
    .from(userFleetAssignments)
    .where(eq(userFleetAssignments.fleetId, fleetId));
  const rows = await db
    .select({ userId: userFleetAssignments.userId, fleetId: userFleetAssignments.fleetId })
    .from(userFleetAssignments)
    .where(inArray(userFleetAssignments.userId, assigned));
  const byUser = new Map<string, string[]>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.fleetId]);
  for (const fleets of byUser.values()) fleets.sort();
  return byUser;
}

/**
 * After a fleet delete: every fleet user it held loses the fleet, so its
 * sessions end (session version, refresh tokens, open streams; its API keys
 * stay and act with the fleets it keeps), its cached access and permissions
 * drop, and its history gets one row. Each user is fail-open: the fleet is
 * already gone, so a failed step only delays what the caches would do.
 */
export async function endDeletedFleetUserSessions(
  fleetId: string,
  assignments: Map<string, string[]>,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<void> {
  for (const [userId, fleetIds] of assignments) {
    try {
      await endUserSessions(userId, { apiKeys: false });
      invalidateSiteAccessCache(userId);
      invalidatePermissionCache(userId);
    } catch (err: unknown) {
      log.warn({ err, userId, fleetId }, 'Ending a fleet user session after a fleet delete failed');
    }
    await writeAudit(
      { table: userAuditLog, idColumn: 'user_id' },
      {
        entityId: userId,
        entityIdSnapshot: userId,
        action: 'updated',
        ...actor,
        before: { fleetIds },
        after: { fleetIds: fleetIds.filter((id) => id !== fleetId) },
        notes: 'Fleet deleted: the user lost the fleet and was signed out',
      },
      db,
      log,
    );
  }
}
