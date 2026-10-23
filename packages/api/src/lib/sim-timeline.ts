// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, gte, lt, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, simAlerts, simSessions } from '@evtivity/database';
import {
  atInWindows,
  spanInWindows,
  type SimInterval,
} from '@evtivity/services/station-sim.service';

// The connectivity timelines: items of several sources in one list, newest
// first, paged with an opaque keyset cursor (time at millisecond precision,
// source, row id), so items that share a time are never skipped. The generic
// part (cursor, per-source conditions, merge and page) serves the station
// timeline (`routes/station-sim.ts`, SIM and OCPP sources) and the SIM page
// timeline (`simTimelinePage`, SIM sources only: the SIM may have sat in
// several stations). Database only.

/** The sources of a timeline and their rank: at one time, items sort by rank, then row id. */
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

/** The rows one source returned (at most limit + 1, newest first), each with its items. */
export interface TimelineSourceRows<S extends string> {
  from: S;
  rows: ReadonlyArray<{ id: number; at: Date; items: readonly TimelineItem[] }>;
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

/** Newest first: time, then source rank, then row id. */
function compareEntries<S extends string>(
  rank: TimelineRank<S>,
  a: TimelineCursor<S>,
  b: TimelineCursor<S>,
): number {
  return b.at.getTime() - a.at.getTime() || rank[b.from] - rank[a.from] || b.id - a.id;
}

/** Times compared at the millisecond the cursor carries, so a tie is a tie. */
export function timelineMs(column: AnyColumn): SQL {
  return sql`date_trunc('milliseconds', ${column})`;
}

/** The rows of one source that come after the cursor in the timeline order. */
export function timelineAfterCursor<S extends string>(
  rank: TimelineRank<S>,
  from: S,
  atColumn: AnyColumn,
  idColumn: AnyColumn,
  cursor: TimelineCursor<S> | null,
): SQL | undefined {
  if (cursor == null) return undefined;
  const at = timelineMs(atColumn);
  const order = rank[from] - rank[cursor.from];
  const sameTime =
    order < 0
      ? sql`${at} = ${cursor.at}`
      : order === 0
        ? and(sql`${at} = ${cursor.at}`, lt(idColumn, cursor.id))
        : undefined;
  return sameTime == null ? sql`${at} < ${cursor.at}` : or(sql`${at} < ${cursor.at}`, sameTime);
}

/**
 * One page of the merged sources. A source that returned more than `limit`
 * rows may hold more rows after its last one; items past the first such row
 * could hide those, so the page stops there (the horizon). A row can give no
 * item or several, so this counts rows. The cursor names a row, so the items
 * of the page's last row all stay on it. `nextCursor` is null at the end.
 */
export function mergeTimelinePage<S extends string>(
  rank: TimelineRank<S>,
  sources: ReadonlyArray<TimelineSourceRows<S>>,
  limit: number,
): { entries: Array<TimelineEntry<S>>; nextCursor: string | null } {
  const compare = (a: TimelineCursor<S>, b: TimelineCursor<S>): number =>
    compareEntries(rank, a, b);
  const entries: Array<TimelineEntry<S>> = sources
    .flatMap((source) =>
      source.rows.flatMap((row) =>
        row.items.map((item) => ({ ...item, at: row.at, from: source.from, id: row.id })),
      ),
    )
    .sort(compare);
  const horizon =
    sources
      .flatMap((source): Array<TimelineCursor<S>> => {
        const last = source.rows[source.rows.length - 1];
        return source.rows.length > limit && last != null
          ? [{ at: last.at, from: source.from, id: last.id }]
          : [];
      })
      .sort(compare)[0] ?? null;
  const known = horizon == null ? entries : entries.filter((e) => compare(e, horizon) <= 0);

  let pageSize = Math.min(limit, known.length);
  const lastKept = known[pageSize - 1];
  while (
    lastKept != null &&
    pageSize < known.length &&
    known[pageSize]?.from === lastKept.from &&
    known[pageSize]?.id === lastKept.id
  ) {
    pageSize += 1;
  }
  const page = known.slice(0, pageSize);
  const last = page[page.length - 1];
  const nextCursor =
    known.length > page.length && last != null
      ? cursorOf(last)
      : horizon != null
        ? cursorOf(horizon)
        : null;
  return { entries: page, nextCursor };
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
  limit: number,
  cursor: TimelineCursor<SimTimelineSource> | null,
  windows: readonly SimInterval[] | null = null,
): Promise<{ items: Array<{ at: string } & TimelineItem>; nextCursor: string | null }> {
  const rank = SIM_TIMELINE_RANK;
  const [sessionRows, alertRows] = await Promise.all([
    // A session that began before the range but ended in it belongs to the range.
    db
      .select()
      .from(simSessions)
      .where(
        and(
          eq(simSessions.simId, simId),
          gte(simSessions.endedAt, range.from),
          lte(simSessions.startedAt, range.to),
          windows == null
            ? undefined
            : spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
          timelineAfterCursor(rank, 'sim:session', simSessions.startedAt, simSessions.id, cursor),
        ),
      )
      .orderBy(desc(timelineMs(simSessions.startedAt)), desc(simSessions.id))
      .limit(limit + 1),
    db
      .select()
      .from(simAlerts)
      .where(
        and(
          eq(simAlerts.simId, simId),
          gte(simAlerts.receivedAt, range.from),
          lte(simAlerts.receivedAt, range.to),
          windows == null ? undefined : atInWindows(simAlerts.receivedAt, windows),
          timelineAfterCursor(rank, 'sim:alert', simAlerts.receivedAt, simAlerts.id, cursor),
        ),
      )
      .orderBy(desc(timelineMs(simAlerts.receivedAt)), desc(simAlerts.id))
      .limit(limit + 1),
  ]);
  const { entries, nextCursor } = mergeTimelinePage(
    rank,
    [
      {
        from: 'sim:session',
        rows: sessionRows.map((s) => ({ id: s.id, at: s.startedAt, items: [simSessionItem(s)] })),
      },
      {
        from: 'sim:alert',
        rows: alertRows.map((a) => ({ id: a.id, at: a.receivedAt, items: [simAlertItem(a)] })),
      },
    ],
    limit,
  );
  return { items: timelineItemsOut(entries), nextCursor };
}
