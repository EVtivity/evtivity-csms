// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { stationSimMatches } from '../schema/sim.js';
import { stationAuditLog } from '../schema/audit.js';
import { writeAudit, type WriteAuditArgs } from './audit.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from './pg-errors.js';

// The only writer of station_sim_matches: the SIM match, its confirmation,
// the operator-entered ICCID, the lookup miss cache and the fetch state of
// the last Refresh. Match set, confirm and clear are audited on the station
// (action `updated` with a note), never with the ICCID or provider ids.

export type SimAuditActor = Pick<
  WriteAuditArgs,
  'actor' | 'actorUserId' | 'actorDriverId' | 'actorApiKeyId' | 'actorLabel'
>;

/** Why a lookup found no SIM for the station. */
export type SimLookupMissReason = 'not_found' | 'sim_matched_elsewhere';

/** The provider's other ids of a matched SIM (Hologram: link and SIM card). */
export interface SimMatchMeta {
  linkId?: string;
  simcardId?: string;
}

export type StationSimMatch = typeof stationSimMatches.$inferSelect;

type AuditLogger = { warn: (obj: unknown, msg?: string) => void };

/** The database, or a transaction a caller holds. */
export type SimMatchDb = Pick<typeof db, 'select' | 'insert' | 'update'>;

async function auditMatch(
  stationId: string,
  note: 'sim_match_set' | 'sim_match_confirmed' | 'sim_match_cleared',
  provider: string | null,
  actor: SimAuditActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  log?: AuditLogger,
  executor: SimMatchDb = db,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
      action: 'updated',
      ...actor,
      notes: provider != null ? `${note} (${provider})` : note,
      before: before == null ? null : { simMatch: before },
      after: after == null ? null : { simMatch: after },
    },
    executor,
    log,
  );
}

export async function getStationSimMatch(
  stationId: string,
  executor: SimMatchDb = db,
): Promise<StationSimMatch | null> {
  const [row] = await executor
    .select()
    .from(stationSimMatches)
    .where(eq(stationSimMatches.stationId, stationId));
  return row ?? null;
}

const NO_ENTERED_ICCID = {
  enteredIccid: null,
  enteredBy: null,
  enteredWithAllSites: false,
} as const;

/** Columns that clear a match and everything fetched for it. */
const CLEARED_MATCH = {
  provider: null,
  providerRef: null,
  meta: null,
  matchedAt: null,
  confirmedAt: null,
  confirmedBy: null,
  sessionsSyncedAt: null,
  lastRecordId: null,
  alertsSyncedAt: null,
  openSessionBeganAt: null,
  lastStatus: null,
  statusFetchedAt: null,
} as const;

export type SetStationSimMatchResult =
  | { matched: true }
  | { matched: false; reason: 'sim_matched_elsewhere' };

/** True when another station holds a confirmed match for this provider SIM. */
async function confirmedElsewhere(
  stationId: string,
  provider: string,
  providerRef: string,
): Promise<boolean> {
  const [row] = await db
    .select({ stationId: stationSimMatches.stationId })
    .from(stationSimMatches)
    .where(
      and(
        eq(stationSimMatches.provider, provider),
        eq(stationSimMatches.providerRef, providerRef),
        isNotNull(stationSimMatches.confirmedAt),
        ne(stationSimMatches.stationId, stationId),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * Stores the SIM a lookup found. A SIM another station holds confirmed is
 * refused (one SIM, one confirmed station) and recorded as a miss; an
 * unconfirmed match elsewhere blocks nothing. `confirm` confirms the match at
 * once for the person who entered the ICCID with access to every site.
 */
export async function setStationSimMatch(
  stationId: string,
  match: {
    provider: string;
    providerRef: string;
    meta: SimMatchMeta;
    confirm: { by: string | null } | null;
  },
  actor: SimAuditActor,
  log?: AuditLogger,
): Promise<SetStationSimMatchResult> {
  const now = new Date();
  const values = {
    ...CLEARED_MATCH,
    provider: match.provider,
    providerRef: match.providerRef,
    meta: match.meta,
    matchedAt: now,
    confirmedAt: match.confirm != null ? now : null,
    confirmedBy: match.confirm?.by ?? null,
    lookupMissedAt: null,
    lookupMissReason: null,
    updatedAt: now,
  };
  if (await confirmedElsewhere(stationId, match.provider, match.providerRef)) {
    await recordSimLookupMiss(stationId, 'sim_matched_elsewhere');
    return { matched: false, reason: 'sim_matched_elsewhere' };
  }
  try {
    await db
      .insert(stationSimMatches)
      .values({ stationId, ...values })
      .onConflictDoUpdate({ target: stationSimMatches.stationId, set: values });
  } catch (err: unknown) {
    // Another station's match was confirmed between the check and this insert.
    if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) throw err;
    await recordSimLookupMiss(stationId, 'sim_matched_elsewhere');
    return { matched: false, reason: 'sim_matched_elsewhere' };
  }
  await auditMatch(
    stationId,
    'sim_match_set',
    match.provider,
    actor,
    null,
    { provider: match.provider, confirmed: match.confirm != null },
    log,
  );
  return { matched: true };
}

/** Caches a lookup that found no usable SIM, so the next Refresh within the hour skips it. */
export async function recordSimLookupMiss(
  stationId: string,
  reason: SimLookupMissReason,
): Promise<void> {
  const now = new Date();
  const values = {
    ...CLEARED_MATCH,
    lookupMissedAt: now,
    lookupMissReason: reason,
    updatedAt: now,
  };
  await db
    .insert(stationSimMatches)
    .values({ stationId, ...values })
    .onConflictDoUpdate({ target: stationSimMatches.stationId, set: values });
}

export type ConfirmStationSimMatchResult =
  | 'confirmed'
  | 'already_confirmed'
  | 'not_matched'
  | 'match_changed'
  | 'confirmed_elsewhere';

/**
 * Confirms the stored match the person saw: `shownMatchedAt` is the
 * `matched_at` of the match the confirmation showed, so a match that changed
 * since (another SIM, or the same SIM matched again) is never confirmed. A
 * match already confirmed stays as it is (no audit row, `confirmed_by` kept);
 * a SIM another station holds confirmed is refused.
 */
export async function confirmStationSimMatch(
  stationId: string,
  actor: SimAuditActor,
  shownMatchedAt: Date,
  log?: AuditLogger,
): Promise<ConfirmStationSimMatchResult> {
  const now = new Date();
  let row: { provider: string | null } | undefined;
  try {
    [row] = await db
      .update(stationSimMatches)
      .set({ confirmedAt: now, confirmedBy: actor.actorUserId ?? null, updatedAt: now })
      .where(
        and(
          eq(stationSimMatches.stationId, stationId),
          isNotNull(stationSimMatches.provider),
          isNull(stationSimMatches.confirmedAt),
          // The dialog shows milliseconds; a stored value may hold microseconds.
          sql`date_trunc('milliseconds', ${stationSimMatches.matchedAt}) = ${shownMatchedAt}`,
        ),
      )
      .returning({ provider: stationSimMatches.provider });
  } catch (err: unknown) {
    if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) throw err;
    return 'confirmed_elsewhere';
  }
  if (row == null) {
    const current = await getStationSimMatch(stationId);
    if (current?.provider == null) return 'not_matched';
    if (current.matchedAt?.getTime() !== shownMatchedAt.getTime()) return 'match_changed';
    return current.confirmedAt != null ? 'already_confirmed' : 'match_changed';
  }
  await auditMatch(
    stationId,
    'sim_match_confirmed',
    row.provider,
    actor,
    null,
    { provider: row.provider, confirmed: true },
    log,
  );
  return 'confirmed';
}

/**
 * Clears the match, its fetch state and a cached miss; the next Refresh
 * looks the SIM up again. `forgetEnteredIccid` also drops the ICCID an
 * operator entered (the station reported another one). True when a match
 * was cleared.
 */
export async function clearStationSimMatch(
  stationId: string,
  actor: SimAuditActor,
  options: { forgetEnteredIccid?: boolean } = {},
  log?: AuditLogger,
  executor: SimMatchDb = db,
): Promise<boolean> {
  const before = await getStationSimMatch(stationId, executor);
  if (before == null) return false;
  await executor
    .update(stationSimMatches)
    .set({
      ...CLEARED_MATCH,
      lookupMissedAt: null,
      lookupMissReason: null,
      ...(options.forgetEnteredIccid === true ? NO_ENTERED_ICCID : {}),
      updatedAt: new Date(),
    })
    .where(eq(stationSimMatches.stationId, stationId));
  if (before.provider == null) return false;
  await auditMatch(
    stationId,
    'sim_match_cleared',
    before.provider,
    actor,
    { provider: before.provider, confirmed: before.confirmedAt != null },
    null,
    log,
    executor,
  );
  return true;
}

/**
 * Records the ICCID an operator entered (normalized; null removes it), who
 * entered it and whether that person had access to every site. When it names
 * another SIM than the station held before, the match is cleared so the next
 * Refresh looks the entered one up; only an entry with access to every site
 * confirms it there. An existing match stays as it is. `executor` is the
 * station update's transaction, so the entry and the station row change together.
 */
export async function recordEnteredIccid(
  stationId: string,
  enteredIccid: string | null,
  changed: boolean,
  entry: { by: string | null; withAllSites: boolean },
  actor: SimAuditActor,
  log?: AuditLogger,
  executor: SimMatchDb = db,
): Promise<void> {
  if (changed) await clearStationSimMatch(stationId, actor, {}, log, executor);
  const now = new Date();
  const values =
    enteredIccid == null
      ? NO_ENTERED_ICCID
      : { enteredIccid, enteredBy: entry.by, enteredWithAllSites: entry.withAllSites };
  await executor
    .insert(stationSimMatches)
    .values({ stationId, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: stationSimMatches.stationId,
      set: { ...values, updatedAt: now },
    });
}

/** The allow-listed SIM status of the last Refresh. */
export interface StoredSimStatus {
  state: string;
  providerState: string;
  inSession: boolean | null;
  openSessionBeganAt: string | null;
  apn: string | null;
  profileName: string | null;
  lastSessionAt: string | null;
  usage: { bytes: number; periodEnd: string | null; limitBytes: number | null } | null;
}

/** The station's current match of this SIM: a Refresh of another SIM writes nothing. */
function matchOfSim(stationId: string, providerRef: string) {
  return and(
    eq(stationSimMatches.stationId, stationId),
    isNotNull(stationSimMatches.provider),
    eq(stationSimMatches.providerRef, providerRef),
  );
}

/** Stores the status of a Refresh of the SIM `providerRef` and the begin of its open session. */
export async function recordSimStatus(
  stationId: string,
  providerRef: string,
  status: StoredSimStatus,
  fetchedAt: Date,
): Promise<void> {
  await db
    .update(stationSimMatches)
    .set({
      lastStatus: status,
      statusFetchedAt: fetchedAt,
      openSessionBeganAt:
        status.openSessionBeganAt != null ? new Date(status.openSessionBeganAt) : null,
      updatedAt: new Date(),
    })
    .where(matchOfSim(stationId, providerRef));
}

/** Moves the session cursor of a days Refresh of the SIM (never back) and its fetch time. */
export async function recordSimSessionsSynced(
  stationId: string,
  providerRef: string,
  newestRecordId: string | null,
  syncedAt: Date,
): Promise<void> {
  const current = await getStationSimMatch(stationId);
  if (current?.provider == null || current.providerRef !== providerRef) return;
  const keep =
    newestRecordId == null ||
    (current.lastRecordId != null && compareRecordIds(current.lastRecordId, newestRecordId) >= 0);
  await db
    .update(stationSimMatches)
    .set({
      ...(keep ? {} : { lastRecordId: newestRecordId }),
      sessionsSyncedAt: syncedAt,
      updatedAt: new Date(),
    })
    .where(matchOfSim(stationId, providerRef));
}

/** Records the fetch time of the alerts of a days Refresh of the SIM. */
export async function recordSimAlertsSynced(
  stationId: string,
  providerRef: string,
  syncedAt: Date,
): Promise<void> {
  await db
    .update(stationSimMatches)
    .set({ alertsSyncedAt: syncedAt, updatedAt: new Date() })
    .where(matchOfSim(stationId, providerRef));
}

/** Compares provider record ids: numerically when both are integers, else as text. */
export function compareRecordIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
