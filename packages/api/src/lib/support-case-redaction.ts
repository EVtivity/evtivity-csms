// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Foreign session links on support cases (owner decision 2026-10-09).
//
// A case visible to a site-restricted operator (supportCaseSiteCondition) can
// still hold sessions of other sites: linked by an all-site operator or a
// driver, or before linking was checked. Those links are hidden from the
// restricted operator, and so is every detail about them: the linked session
// list, messages that name them (refund messages) and the audit rows that
// reference them.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  supportCaseAuditLog,
  supportCaseSessions,
} from '@evtivity/database';

type SupportCaseAuditAction = (typeof supportCaseAuditLog.action.enumValues)[number];

/** Audit actions whose before or after name sessions (sessionIds or sessionId). */
export const SESSION_AUDIT_ACTIONS: SupportCaseAuditAction[] = [
  'sessions_linked',
  'sessions_unlinked',
  'refund_issued',
];

/**
 * SQL on support_case_audit_log rows: false for a row of a session action
 * that names no session of the user's sites. Rows naming some of the user's
 * sessions stay and are trimmed by redactSupportCaseAuditRows.
 */
export function supportCaseAuditSessionCondition(siteIds: string[]): SQL {
  if (siteIds.length === 0) return sql`false`;
  const table = sql.identifier('support_case_audit_log');
  const actions = sql.join(
    SESSION_AUDIT_ACTIONS.map((a) => sql`${a}`),
    sql`, `,
  );
  const siteList = sql.join(
    siteIds.map((siteId) => sql`${siteId}`),
    sql`, `,
  );
  return sql`(${table}.action::text NOT IN (${actions}) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(
      ${table}.after->'sessionIds',
      ${table}.before->'sessionIds',
      jsonb_build_array(${table}.after->>'sessionId')
    )) AS ref(session_id)
    JOIN ${chargingSessions} ON ${chargingSessions.id} = ref.session_id
    JOIN ${chargingStations} ON ${chargingStations.id} = ${chargingSessions.stationId}
    WHERE ${chargingStations.siteId} IN (${siteList})
  ))`;
}

function sessionRefsOf(value: unknown): string[] {
  if (value == null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const refs: string[] = [];
  const list = record['sessionIds'];
  if (Array.isArray(list)) {
    for (const id of list) if (typeof id === 'string') refs.push(id);
  }
  const single = record['sessionId'];
  if (typeof single === 'string') refs.push(single);
  return refs;
}

/** The session ids an audit row's before and after name. */
export function auditRowSessionRefs(row: { before: unknown; after: unknown }): string[] {
  return [...sessionRefsOf(row.before), ...sessionRefsOf(row.after)];
}

/** The given session ids that ran at a station in the user's sites. */
export async function sessionIdsInSites(
  sessionIds: Iterable<string>,
  siteIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0 || siteIds.length === 0) return new Set();
  const rows = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .where(and(inArray(chargingSessions.id, unique), inArray(chargingStations.siteId, siteIds)));
  return new Set(rows.map((r) => r.id));
}

function trimSessionRefs(value: unknown, visible: Set<string>): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const list = record['sessionIds'];
  if (Array.isArray(list)) {
    record['sessionIds'] = list.filter((id) => typeof id === 'string' && visible.has(id));
  }
  return record;
}

/**
 * Trim the session lists of support case audit rows to the sessions of the
 * user's sites, for a site-restricted user (siteIds an array). Rows naming
 * none of them are already excluded by supportCaseAuditSessionCondition.
 * Other rows, and every row for an all-site user, pass unchanged.
 */
export async function redactSupportCaseAuditRows<
  T extends { entityType: string; before: unknown; after: unknown },
>(rows: T[], siteIds: string[] | null): Promise<T[]> {
  if (siteIds == null) return rows;
  const caseRows = rows.filter((r) => r.entityType === 'support_case');
  if (caseRows.length === 0) return rows;
  const visible = await sessionIdsInSites(caseRows.flatMap(auditRowSessionRefs), siteIds);
  return rows.map((r) =>
    r.entityType === 'support_case'
      ? {
          ...r,
          before: trimSessionRefs(r.before, visible),
          after: trimSessionRefs(r.after, visible),
        }
      : r,
  );
}

export interface ForeignSessionRefs {
  sessionIds: Set<string>;
  transactionIds: Set<string>;
}

/**
 * The sessions a case references (linked now, or named by its audit rows)
 * that did not run in the user's sites, with their transaction ids. Empty
 * for an all-site user.
 */
export async function foreignCaseSessionRefs(
  caseId: string,
  siteIds: string[] | null,
): Promise<ForeignSessionRefs> {
  const empty: ForeignSessionRefs = { sessionIds: new Set(), transactionIds: new Set() };
  if (siteIds == null) return empty;
  const [links, auditRows] = await Promise.all([
    db
      .select({ sessionId: supportCaseSessions.sessionId })
      .from(supportCaseSessions)
      .where(eq(supportCaseSessions.caseId, caseId)),
    db
      .select({ before: supportCaseAuditLog.before, after: supportCaseAuditLog.after })
      .from(supportCaseAuditLog)
      .where(
        and(
          eq(supportCaseAuditLog.supportCaseId, caseId),
          inArray(supportCaseAuditLog.action, SESSION_AUDIT_ACTIONS),
        ),
      ),
  ]);
  const refs = new Set([
    ...links.map((l) => l.sessionId),
    ...auditRows.flatMap(auditRowSessionRefs),
  ]);
  if (refs.size === 0) return empty;
  const visible = await sessionIdsInSites(refs, siteIds);
  const foreign = [...refs].filter((id) => !visible.has(id));
  if (foreign.length === 0) return empty;
  const sessions = await db
    .select({ transactionId: chargingSessions.transactionId })
    .from(chargingSessions)
    .where(inArray(chargingSessions.id, foreign));
  return {
    sessionIds: new Set(foreign),
    transactionIds: new Set(sessions.map((s) => s.transactionId).filter((t) => t !== '')),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a case message names a foreign session: any message containing
 * a foreign session id, or a system message naming a foreign transaction id
 * as "session <id>" (the refund messages).
 */
export function messageReferencesForeignSession(
  message: { senderType: string; body: string },
  foreign: ForeignSessionRefs,
): boolean {
  for (const id of foreign.sessionIds) if (message.body.includes(id)) return true;
  if (message.senderType !== 'system') return false;
  for (const tx of foreign.transactionIds) {
    if (new RegExp(`\\bsession ${escapeRegExp(tx)}(?![A-Za-z0-9_-])`).test(message.body)) {
      return true;
    }
  }
  return false;
}
