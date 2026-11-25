// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { jobQueue } from '@evtivity/lib/job-queues';
import {
  LOAD_MANAGEMENT_QUEUE,
  LOAD_MANAGEMENT_RECOMPUTE_DEBOUNCE_MS,
  LOAD_MANAGEMENT_RECOMPUTE_JOB_NAME,
  LOAD_MANAGEMENT_RECOMPUTE_JOB_OPTIONS,
  loadManagementEventJobId,
} from '@evtivity/lib/worker-queues';

/** What an event names: a station (database id or OCPP identity) or a site. */
export type LoadManagementRecomputeTarget =
  | { stationUuid: string }
  | { stationOcppId: string }
  | { siteId: string };

/**
 * Asks the worker to compute a site's allocation again soon, instead of at the
 * next periodic cycle: stores `recompute_requested_at` (so a cycle that is
 * already running sees it and runs once more) and adds the debounced event job
 * of the site (one job id per site, so a burst of events is one job). Only for
 * a site with load management on, and for a station only while it is on a
 * circuit. Returns the sites asked. Throws; callers are fail-open.
 */
export async function requestLoadManagementRecompute(
  sql: postgres.Sql,
  target: LoadManagementRecomputeTarget,
  trigger: string,
): Promise<string[]> {
  const rows =
    'siteId' in target
      ? await sql<{ site_id: string }[]>`
          UPDATE site_load_management
          SET recompute_requested_at = now()
          WHERE site_id = ${target.siteId} AND is_enabled = true
          RETURNING site_id
        `
      : await sql<{ site_id: string }[]>`
          UPDATE site_load_management slm
          SET recompute_requested_at = now()
          FROM charging_stations cs
          WHERE ${
            'stationUuid' in target
              ? sql`cs.id = ${target.stationUuid}`
              : sql`cs.station_id = ${target.stationOcppId}`
          }
            AND cs.circuit_id IS NOT NULL
            AND slm.site_id = cs.site_id
            AND slm.is_enabled = true
          RETURNING slm.site_id
        `;
  const siteIds = rows.map((r) => r.site_id);
  const queue = jobQueue(LOAD_MANAGEMENT_QUEUE, LOAD_MANAGEMENT_RECOMPUTE_JOB_OPTIONS);
  await Promise.all(
    siteIds.map((siteId) =>
      queue.add(
        LOAD_MANAGEMENT_RECOMPUTE_JOB_NAME,
        { siteId, trigger },
        { jobId: loadManagementEventJobId(siteId), delay: LOAD_MANAGEMENT_RECOMPUTE_DEBOUNCE_MS },
      ),
    ),
  );
  return siteIds;
}

/**
 * Records that a run found the site's cycle running and computed nothing: the
 * running cycle sees it after it ends (`recomputeRequestedSince`) and queues
 * one follow-up, so a busy run neither waits for the lock nor queues a job.
 */
export async function markLoadManagementRecomputeRequested(
  sql: postgres.Sql,
  siteId: string,
): Promise<void> {
  await sql`
    UPDATE site_load_management SET recompute_requested_at = now()
    WHERE site_id = ${siteId} AND is_enabled = true
  `;
}

/** The database time a cycle starts at, as postgres text (compared in SQL only). */
export async function loadManagementCycleStart(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ at: string }[]>`SELECT now()::text AS at`;
  return rows[0]?.at ?? new Date().toISOString();
}

/**
 * Whether an event asked for a recompute of the site after `since` (from
 * `loadManagementCycleStart`, the database clock): the cycle then queues one
 * more run, so an event that landed while it ran is never lost.
 */
export async function recomputeRequestedSince(
  sql: postgres.Sql,
  siteId: string,
  since: string,
): Promise<boolean> {
  const rows = await sql<{ requested: boolean }[]>`
    SELECT recompute_requested_at >= ${since}::timestamptz AS requested
    FROM site_load_management
    WHERE site_id = ${siteId} AND is_enabled = true
  `;
  return rows[0]?.requested === true;
}
