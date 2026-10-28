// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, gte, inArray, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, simAlerts, simSessions } from '@evtivity/database';
import {
  atInWindows,
  spanInWindows,
  type SimInterval,
} from '@evtivity/services/station-sim.service';

// The connectivity timelines: entries of several sources in one list, newest
// first (time at millisecond precision, then source rank, then row id, so
// entries that share a time keep one order). One SQL query merges the sources
// (UNION ALL), another counts the entries, and a page is read either by page
// number (the CSMS Prev and Next) or after an opaque keyset cursor. The
// generic part serves the station timeline (`routes/station-sim.ts`, SIM and
// OCPP sources) and the SIM page timeline (`simTimelinePage`, SIM sources
// only: the SIM may have sat in several stations). Database only.

/** The sources of a timeline and their rank: at one time, entries sort by rank, then row id. */
export type TimelineRank<S extends string> = Readonly<Record<S, number>>;

export interface TimelineCursor<S extends string> {
  at: Date;
  from: S;
  id: number;
}

export interface TimelineItem {
  source: 'sim' | 'ocpp';
  kind: string;
  details: Record<string, unknown>;
}

export interface TimelineEntry<S extends string> extends TimelineCursor<S>, TimelineItem {}

/**
 * One source of a timeline: the rows of `table` that `where` keeps, by row id
 * and time. Every row the condition keeps must give at least one item, so the
 * count is the number of entries the pages show.
 */
export interface TimelineSourceSpec<S extends string> {
  from: S;
  table: PgTable;
  id: AnyColumn;
  at: AnyColumn;
  where: SQL | undefined;
}

/** A page by number (from 1) or the page after a cursor, of `limit` entries. */
export type TimelinePaging<S extends string> =
  | { kind: 'page'; page: number; limit: number }
  | { kind: 'cursor'; cursor: TimelineCursor<S>; limit: number };

export interface TimelinePageKeys<S extends string> {
  /** The entries of the page, newest first. */
  keys: Array<TimelineCursor<S>>;
  /** The entries of the whole timeline. */
  total: number;
  /** The cursor of the next page; null on the last one. */
  nextCursor: string | null;
  /** Time of the last entry before the page; null on the first page. */
  previousAt: Date | null;
}

function cursorOf<S extends string>(entry: TimelineCursor<S>): string {
  return Buffer.from(`${entry.at.toISOString()}|${entry.from}|${String(entry.id)}`).toString(
    'base64url',
  );
}

/** The cursor a page handed out; null when it is not one of this timeline. */
export function parseTimelineCursor<S extends string>(
  cursor: string,
  rank: TimelineRank<S>,
): TimelineCursor<S> | null {
  const [iso, from, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (iso == null || from == null || id == null || !Object.hasOwn(rank, from)) return null;
  const at = new Date(iso);
  const rowId = Number(id);
  if (Number.isNaN(at.getTime()) || !Number.isSafeInteger(rowId)) return null;
  return { at, from: from as S, id: rowId };
}

/** The paging fields of a timeline query, shared by the station and SIM page timelines. */
export const timelinePagingQueryFields = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Entries per page, default 200'),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Page number, from 1 (default 1). Not with a cursor'),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe('nextCursor of the previous page: the page after it. Not with a page'),
};

/** The paging fields of a timeline reply. */
export const timelinePagingResponseFields = {
  nextCursor: z.string().nullable().describe('The cursor of the next page, null at the end'),
  total: z
    .number()
    .int()
    .describe(
      'Entries in the range, for the page count. An entry is a stored row; a station event row can hold more than one item',
    ),
  page: z.number().int().nullable().describe('The page read; null when read with a cursor'),
  previousAt: z
    .string()
    .nullable()
    .describe('Time of the last entry before this page; null on the first page'),
};

/** Entries per page when the request names none. */
export const TIMELINE_DEFAULT_LIMIT = 200;

/**
 * The paging of a timeline request: a cursor, else a page (default 1). Both
 * at once, or a cursor this timeline did not hand out, is an error message.
 */
export function timelinePaging<S extends string>(
  query: { page?: number | undefined; limit?: number | undefined; cursor?: string | undefined },
  rank: TimelineRank<S>,
): TimelinePaging<S> | { error: string } {
  const limit = query.limit ?? TIMELINE_DEFAULT_LIMIT;
  if (query.cursor == null) return { kind: 'page', page: query.page ?? 1, limit };
  if (query.page != null) return { error: 'Send a page or a cursor, not both' };
  const cursor = parseTimelineCursor(query.cursor, rank);
  return cursor == null ? { error: 'The cursor is not valid' } : { kind: 'cursor', cursor, limit };
}

/** Times compared at the millisecond the cursor carries, so a tie is a tie. */
export function timelineMs(column: AnyColumn): SQL {
  return sql`date_trunc('milliseconds', ${column})`;
}

/**
 * The rows to read for a page: a page after the first reads one entry more at
 * its start (the last entry of the previous page, for `previousAt`), and every
 * page one more at its end (to tell whether a next page exists).
 */
export function timelineReadWindow<S extends string>(
  paging: TimelinePaging<S>,
): { offset: number; count: number; withPrevious: boolean } {
  if (paging.kind === 'page' && paging.page > 1) {
    return {
      offset: (paging.page - 1) * paging.limit - 1,
      count: paging.limit + 2,
      withPrevious: true,
    };
  }
  return { offset: 0, count: paging.limit + 1, withPrevious: false };
}

/**
 * Splits the rows read for a page (`timelineReadWindow`) into the page's
 * entries, the time before the page and the next cursor.
 */
export function splitTimelineRows<S extends string>(
  paging: TimelinePaging<S>,
  rows: ReadonlyArray<TimelineCursor<S>>,
): Omit<TimelinePageKeys<S>, 'total'> {
  const { withPrevious } = timelineReadWindow(paging);
  const previous = withPrevious ? (rows[0] ?? null) : null;
  const rest = withPrevious ? rows.slice(1) : rows;
  const keys = rest.slice(0, paging.limit);
  const last = keys[keys.length - 1];
  return {
    keys,
    nextCursor: rest.length > paging.limit && last != null ? cursorOf(last) : null,
    previousAt: paging.kind === 'cursor' ? paging.cursor.at : (previous?.at ?? null),
  };
}

/** The page's entries of the merged sources, and how many entries there are. */
export async function timelinePageKeys<S extends string>(
  rank: TimelineRank<S>,
  sources: ReadonlyArray<TimelineSourceSpec<S>>,
  paging: TimelinePaging<S>,
): Promise<TimelinePageKeys<S>> {
  if (sources.length === 0) {
    return { keys: [], total: 0, nextCursor: null, previousAt: null };
  }
  const byRank = new Map<number, S>(
    (Object.keys(rank) as S[]).map((from) => [rank[from], from] as const),
  );
  const merged = sql.join(
    sources.map(
      (s) =>
        sql`SELECT ${sql.raw(String(rank[s.from]))}::int AS rank, ${s.id}::bigint AS id, ${timelineMs(s.at)} AS at FROM ${s.table} WHERE ${s.where ?? sql`true`}`,
    ),
    sql` UNION ALL `,
  );
  const after =
    paging.kind === 'cursor'
      ? sql`WHERE (t.at, t.rank, t.id) < (${paging.cursor.at.toISOString()}::timestamptz, ${rank[paging.cursor.from]}::int, ${paging.cursor.id}::bigint)`
      : sql``;
  const { offset, count } = timelineReadWindow(paging);
  const [rows, totals] = await Promise.all([
    db.execute(sql`
      SELECT t.rank, t.id, (extract(epoch FROM t.at) * 1000)::bigint AS at_ms
      FROM (${merged}) t
      ${after}
      ORDER BY t.at DESC, t.rank DESC, t.id DESC
      LIMIT ${count} OFFSET ${offset}`),
    db.execute(sql`SELECT count(*)::int AS total FROM (${merged}) t`),
  ]);
  const read = (rows as unknown as Array<Record<string, unknown>>).flatMap(
    (row): Array<TimelineCursor<S>> => {
      const from = byRank.get(Number(row.rank));
      return from == null ? [] : [{ at: new Date(Number(row.at_ms)), from, id: Number(row.id) }];
    },
  );
  const total = Number((totals as unknown as Array<Record<string, unknown>>)[0]?.total ?? 0);
  return { ...splitTimelineRows(paging, read), total };
}

/**
 * The entries of the page in the order of its keys: each key's items from the
 * rows read by id (`items` gives the items of a source's row).
 */
export function timelineEntries<S extends string>(
  keys: ReadonlyArray<TimelineCursor<S>>,
  items: (from: S, id: number) => readonly TimelineItem[] | undefined,
): Array<TimelineEntry<S>> {
  return keys.flatMap((key) =>
    (items(key.from, key.id) ?? []).map((item) => ({ ...item, ...key })),
  );
}

/** The row ids of one source among the page's keys. */
export function timelineIdsOf<S extends string>(
  keys: ReadonlyArray<TimelineCursor<S>>,
  from: S,
): number[] {
  return keys.filter((key) => key.from === from).map((key) => key.id);
}

/** The items as the replies show them. */
export function timelineItemsOut<S extends string>(
  entries: ReadonlyArray<TimelineEntry<S>>,
): Array<{ at: string } & TimelineItem> {
  return entries.map((entry) => ({
    at: entry.at.toISOString(),
    source: entry.source,
    kind: entry.kind,
    details: entry.details,
  }));
}

export interface TimelinePageOut {
  items: Array<{ at: string } & TimelineItem>;
  nextCursor: string | null;
  total: number;
  page: number | null;
  previousAt: string | null;
}

/** The items and paging fields of a reply. */
export function timelinePageOut<S extends string>(
  paging: TimelinePaging<S>,
  page: TimelinePageKeys<S>,
  entries: ReadonlyArray<TimelineEntry<S>>,
): TimelinePageOut {
  return {
    items: timelineItemsOut(entries),
    nextCursor: page.nextCursor,
    total: page.total,
    page: paging.kind === 'page' ? paging.page : null,
    previousAt: page.previousAt?.toISOString() ?? null,
  };
}

/** A stored SIM session as a timeline item. */
export function simSessionItem(s: typeof simSessions.$inferSelect): TimelineItem {
  return {
    source: 'sim',
    kind: 'session',
    details: {
      provider: s.provider,
      endedAt: s.endedAt.toISOString(),
      bytes: s.bytes,
      networkName: s.networkName,
      radioAccessTechnology: s.radioAccessTechnology,
      cellId: s.cellId,
      apn: s.apn,
    },
  };
}

/** A stored SIM alert as a timeline item. */
export function simAlertItem(a: typeof simAlerts.$inferSelect): TimelineItem {
  return { source: 'sim', kind: a.kind, details: { provider: a.provider } };
}

// ---------------------------------------------------------------------------
// The SIM page timeline

type SimTimelineSource = 'sim:session' | 'sim:alert';
export const SIM_TIMELINE_RANK: TimelineRank<SimTimelineSource> = {
  'sim:session': 1,
  'sim:alert': 0,
};

/** The cursor of a SIM page timeline; null when it is not one. */
export function parseSimTimelineCursor(cursor: string): TimelineCursor<SimTimelineSource> | null {
  return parseTimelineCursor(cursor, SIM_TIMELINE_RANK);
}

/**
 * One page of the SIM's sessions and alerts in the range. `windows` (a
 * site-restricted viewer, `simSiteWindows`) keeps only the rows inside them;
 * null shows them all.
 */
export async function simTimelinePage(
  simId: string,
  range: { from: Date; to: Date },
  paging: TimelinePaging<SimTimelineSource>,
  windows: readonly SimInterval[] | null = null,
): Promise<TimelinePageOut> {
  const page = await timelinePageKeys(
    SIM_TIMELINE_RANK,
    [
      // A session that began before the range but ended in it belongs to the range.
      {
        from: 'sim:session',
        table: simSessions,
        id: simSessions.id,
        at: simSessions.startedAt,
        where: and(
          eq(simSessions.simId, simId),
          gte(simSessions.endedAt, range.from),
          lte(simSessions.startedAt, range.to),
          windows == null
            ? undefined
            : spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
        ),
      },
      {
        from: 'sim:alert',
        table: simAlerts,
        id: simAlerts.id,
        at: simAlerts.receivedAt,
        where: and(
          eq(simAlerts.simId, simId),
          gte(simAlerts.receivedAt, range.from),
          lte(simAlerts.receivedAt, range.to),
          windows == null ? undefined : atInWindows(simAlerts.receivedAt, windows),
        ),
      },
    ],
    paging,
  );
  const sessionIds = timelineIdsOf(page.keys, 'sim:session');
  const alertIds = timelineIdsOf(page.keys, 'sim:alert');
  const [sessionRows, alertRows] = await Promise.all([
    sessionIds.length === 0
      ? []
      : db.select().from(simSessions).where(inArray(simSessions.id, sessionIds)),
    alertIds.length === 0 ? [] : db.select().from(simAlerts).where(inArray(simAlerts.id, alertIds)),
  ]);
  const sessions = new Map(sessionRows.map((s) => [s.id, [simSessionItem(s)]]));
  const alerts = new Map(alertRows.map((a) => [a.id, [simAlertItem(a)]]));
  const entries = timelineEntries(page.keys, (from, id) =>
    from === 'sim:session' ? sessions.get(id) : alerts.get(id),
  );
  return timelinePageOut(paging, page, entries);
}
