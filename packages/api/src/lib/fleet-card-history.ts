// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, drivers, tokenAuditLog, userFleetAssignments, users } from '@evtivity/database';
import { FLEET_CARD_DEACTIVATE_REASON, FLEET_CARD_RELEASE_REASON } from '@evtivity/lib/fleet-card';
import { visibleUserIds } from './user-management-scope.js';

export type FleetCardChange =
  | 'limit_changed'
  | 'added'
  | 'moved_into_fleet'
  | 'moved_out_of_fleet'
  | 'given'
  | 'taken_back'
  | 'renamed'
  | 'turned_off'
  | 'turned_on'
  | 'deactivated'
  | 'changed'
  | 'deleted';

export type FleetCardActorKind = 'fleet_user' | 'operator' | 'driver' | 'system';

export interface FleetCardHistoryMember {
  id: string;
  name: string | null;
  erased: boolean;
}

export interface FleetCardHistoryEntry {
  id: number;
  createdAt: Date | string;
  changes: FleetCardChange[];
  reason: 'member_left' | null;
  memberBefore: FleetCardHistoryMember | null;
  memberAfter: FleetCardHistoryMember | null;
  labelBefore: string | null;
  labelAfter: string | null;
  actor: { kind: FleetCardActorKind; name: string | null; viaApiKey: boolean };
}

export interface FleetCardAuditRow {
  id: number;
  action: string;
  actor: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  before: unknown;
  after: unknown;
  notes: string | null;
  createdAt: Date | string;
}

interface Snapshot {
  driverId: string | null;
  label: string | null;
  fleetId: string | null;
  monthlyLimitCents: number | null;
}

function snapshotOf(value: unknown): Snapshot | null {
  if (value == null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | null => (typeof v[k] === 'string' ? v[k] : null);
  const limit = v['monthlyLimitCents'];
  return {
    driverId: str('driverId'),
    label: str('label'),
    fleetId: str('fleetId'),
    monthlyLimitCents: typeof limit === 'number' ? limit : null,
  };
}

/** What a reader learns about a user who acted: its kind and, when allowed, its name. */
export interface ActorInfo {
  kind: 'fleet_user' | 'operator';
  name: string | null;
}

/**
 * The entries of one fleet card's audit rows, newest first as given. Only
 * the card's time in this fleet shows: the side of a row from before the
 * card joined the fleet, or after it left, names no member and no label,
 * and the RFID value and type never appear. Free-text notes stay out.
 */
export function fleetCardHistoryEntries(
  rows: readonly FleetCardAuditRow[],
  fleetId: string,
  actors: ReadonlyMap<string, ActorInfo>,
  members: ReadonlyMap<string, FleetCardHistoryMember>,
): FleetCardHistoryEntry[] {
  return rows.map((row) => {
    const before = snapshotOf(row.before);
    const after = snapshotOf(row.after);
    const beforeIn = before?.fleetId === fleetId;
    const afterIn = after?.fleetId === fleetId;
    const shownBefore = beforeIn ? before : null;
    const shownAfter = afterIn ? after : null;
    const changes: FleetCardChange[] = [];

    if (row.action === 'created' || row.action === 'imported') changes.push('added');
    else if (row.action === 'deleted') changes.push('deleted');
    else {
      if (before != null && !beforeIn && afterIn) changes.push('moved_into_fleet');
      if (beforeIn && after != null && !afterIn) changes.push('moved_out_of_fleet');
      if (row.action === 'activated') changes.push('turned_on');
      if (row.action === 'revoked') changes.push('deactivated');
      if (row.action === 'deactivated') {
        changes.push(row.notes === FLEET_CARD_DEACTIVATE_REASON ? 'deactivated' : 'turned_off');
      }
    }
    if (shownBefore != null && shownAfter != null) {
      if (shownBefore.driverId !== shownAfter.driverId) {
        changes.push(shownAfter.driverId == null ? 'taken_back' : 'given');
      }
      if (shownBefore.label !== shownAfter.label) changes.push('renamed');
      // The amounts stay out, like the earlier values of every other field.
      if (shownBefore.monthlyLimitCents !== shownAfter.monthlyLimitCents) {
        changes.push('limit_changed');
      }
    } else if (row.action !== 'deleted' && shownAfter?.driverId != null) {
      changes.push('given');
    }
    if (changes.length === 0) changes.push('changed');

    const member = (id: string | null | undefined): FleetCardHistoryMember | null =>
      id == null ? null : (members.get(id) ?? { id, name: null, erased: false });

    let actor: FleetCardHistoryEntry['actor'];
    if (row.actorUserId != null) {
      const info = actors.get(row.actorUserId) ?? { kind: 'operator' as const, name: null };
      actor = { kind: info.kind, name: info.name, viaApiKey: row.actorApiKeyId != null };
    } else if (row.actor === 'driver') {
      actor = { kind: 'driver', name: null, viaApiKey: false };
    } else if (row.actor === 'api_key') {
      actor = { kind: 'operator', name: null, viaApiKey: true };
    } else {
      actor = { kind: 'system', name: null, viaApiKey: false };
    }

    return {
      id: row.id,
      createdAt: row.createdAt,
      changes,
      reason: row.notes === FLEET_CARD_RELEASE_REASON ? 'member_left' : null,
      memberBefore: member(shownBefore?.driverId),
      memberAfter: member(shownAfter?.driverId),
      labelBefore: shownBefore?.label ?? null,
      labelAfter: shownAfter?.label ?? null,
      actor,
    };
  });
}

function personName(first: string | null, last: string | null): string | null {
  const name = [first ?? '', last ?? ''].join(' ').trim();
  return name === '' ? null : name;
}

/** Rows of the card's time in the fleet: a snapshot before or after names the fleet. */
function inFleetCondition(fleetId: string) {
  return or(
    sql`${tokenAuditLog.before}->>'fleetId' = ${fleetId}`,
    sql`${tokenAuditLog.after}->>'fleetId' = ${fleetId}`,
  );
}

export interface FleetCardHistoryReader {
  userId: string;
  fleetUser: boolean;
  siteIds: string[] | null;
}

/**
 * One page of a fleet card's history. A fleet user reads the names of the
 * fleet's own fleet users; every other user who acted shows as an operator
 * without a name. An operator reads the names of the users it may see
 * (every user for access to every site). A name is never an email.
 */
export async function readFleetCardHistory(
  tokenId: string,
  fleetId: string,
  reader: FleetCardHistoryReader,
  page: number,
  limit: number,
): Promise<{ data: FleetCardHistoryEntry[]; total: number }> {
  const where = and(eq(tokenAuditLog.tokenId, tokenId), inFleetCondition(fleetId));
  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: tokenAuditLog.id,
        action: tokenAuditLog.action,
        actor: tokenAuditLog.actor,
        actorUserId: tokenAuditLog.actorUserId,
        actorApiKeyId: tokenAuditLog.actorApiKeyId,
        before: tokenAuditLog.before,
        after: tokenAuditLog.after,
        notes: tokenAuditLog.notes,
        createdAt: tokenAuditLog.createdAt,
      })
      .from(tokenAuditLog)
      .where(where)
      .orderBy(desc(tokenAuditLog.createdAt), desc(tokenAuditLog.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tokenAuditLog)
      .where(where),
  ]);

  const userIds = [...new Set(rows.flatMap((r) => (r.actorUserId == null ? [] : [r.actorUserId])))];
  const driverIds = new Set<string>();
  for (const r of rows) {
    for (const s of [snapshotOf(r.before), snapshotOf(r.after)]) {
      if (s?.fleetId === fleetId && s.driverId != null) driverIds.add(s.driverId);
    }
  }

  const [userRows, assignedRows, driverRows, visible] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            accessScope: users.accessScope,
          })
          .from(users)
          .where(inArray(users.id, userIds)),
    userIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ userId: userFleetAssignments.userId })
          .from(userFleetAssignments)
          .where(
            and(
              inArray(userFleetAssignments.userId, userIds),
              eq(userFleetAssignments.fleetId, fleetId),
            ),
          ),
    driverIds.size === 0
      ? Promise.resolve([])
      : db
          .select({
            id: drivers.id,
            firstName: drivers.firstName,
            lastName: drivers.lastName,
            erasedAt: drivers.erasedAt,
          })
          .from(drivers)
          .where(inArray(drivers.id, [...driverIds])),
    reader.fleetUser || userIds.length === 0
      ? Promise.resolve(null)
      : visibleUserIds(userIds, reader.userId, reader.siteIds),
  ]);

  const assigned = new Set(assignedRows.map((r) => r.userId));
  const actors = new Map<string, ActorInfo>();
  for (const u of userRows) {
    const ofFleet = u.accessScope === 'fleets' && assigned.has(u.id);
    const kind = u.accessScope === 'fleets' ? 'fleet_user' : 'operator';
    const named = reader.fleetUser
      ? ofFleet || u.id === reader.userId
      : visible == null || visible.has(u.id);
    actors.set(u.id, { kind, name: named ? personName(u.firstName, u.lastName) : null });
  }
  const members = new Map<string, FleetCardHistoryMember>();
  for (const d of driverRows) {
    const erased = d.erasedAt != null;
    members.set(d.id, {
      id: d.id,
      name: erased ? null : personName(d.firstName, d.lastName),
      erased,
    });
  }

  return {
    data: fleetCardHistoryEntries(rows, fleetId, actors, members),
    total: countRows[0]?.count ?? 0,
  };
}
