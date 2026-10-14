// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql as drizzleSql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type postgres from 'postgres';

type TemplateTag = (strings: TemplateStringsArray, ...values: string[]) => unknown;

/**
 * The value of `charging_sessions.site_id` for a new session: the site its
 * station is at when the session starts, so a station moved to another site
 * later leaves the session (its revenue, energy and reports) at this site.
 *
 * Every insert into `charging_sessions` sets `site_id` with this helper,
 * inside the INSERT, so the station row read and the insert are one
 * statement. Pass the query builder that runs the insert: drizzle's `sql`
 * (for `.values({ siteId })`) or a postgres.js `Sql` (interpolated as a
 * fragment). The guard test `session-site-guard.test.ts` refuses an insert
 * without it.
 */
export function sessionSiteIdSql(tag: typeof drizzleSql, stationId: string): SQL<string | null>;
export function sessionSiteIdSql(
  tag: postgres.Sql | postgres.TransactionSql,
  stationId: string,
): postgres.PendingQuery<postgres.Row[]>;
export function sessionSiteIdSql(tag: TemplateTag, stationId: string): unknown {
  return tag`(SELECT site_id FROM charging_stations WHERE id = ${stationId})`;
}
