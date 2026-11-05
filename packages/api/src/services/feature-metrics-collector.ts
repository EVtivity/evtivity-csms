// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, isVdv463Enabled } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  workerJobsLastHour,
  workerJobDurationAvgMs,
  workerJobDurationMaxMs,
  cronJobLastFailed,
  loadManagementSitesEnabled,
  loadManagementSitesOverCapacity,
  loadManagementAppliedAgeMaxSeconds,
  loadManagementSitesSendFailed,
  loadManagementSupplyCreditKw,
  departuresScheduled,
  departureNoticesLastHour,
  departuresCompletedLast24h,
  chargingPlansStale,
  chargingPlanStalenessMaxSeconds,
  chargingPlanRuntimeMaxMs,
  energyAssetsTotal,
  energyAssetsReadingStale,
  depotInterfaceEnabled,
  depotSystemsEnabled,
  depotSystemsAuthLocked,
  depotSystemRefusedRequests,
} from '../plugins/metrics.js';

const logger = createLogger('feature-metrics-collector');

/** The run in progress, so a tick never starts a second one beside it. */
let collecting: Promise<void> | null = null;

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  return Array.isArray(result) ? (result as Row[]) : [];
}

function num(row: Row | undefined, key: string): number {
  const value = row?.[key];
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The gauges of the worker jobs and crons, load management, route-aware
 * charging, batteries and solar, and the bus depot interface. Every value
 * comes from the database (the worker exposes no metrics endpoint), so each
 * API task exports the same value and dashboards aggregate with max(). Labels
 * are bounded: queue and cron names, readiness, outcome, notice kind, asset
 * type and refusal reason; never a site, station or system id.
 */
export async function collectFeatureMetrics(): Promise<void> {
  if (collecting != null) {
    logger.debug('Feature metrics collection skipped, the previous run is still running');
    return;
  }
  collecting = runFeatureCollection();
  try {
    await collecting;
  } finally {
    collecting = null;
  }
}

async function runFeatureCollection(): Promise<void> {
  try {
    const [
      jobRows,
      durationRows,
      cronRows,
      loadRows,
      departureRows,
      noticeRows,
      outcomeRows,
      planRows,
      assetRows,
      depotRows,
      refusedRows,
      interfaceOn,
    ] = await Promise.all([
      // idx_worker_job_logs_started_at serves the window.
      db.execute(sql`
        SELECT queue, status::text AS status, count(*)::int AS count
        FROM worker_job_logs
        WHERE started_at >= NOW() - INTERVAL '1 hour'
        GROUP BY queue, status
      `),
      db.execute(sql`
        SELECT queue,
          COALESCE(AVG(duration_ms), 0)::float AS avg_ms,
          COALESCE(MAX(duration_ms), 0)::int AS max_ms
        FROM worker_job_logs
        WHERE started_at >= NOW() - INTERVAL '1 hour'
          AND completed_at >= NOW() - INTERVAL '15 minutes'
          AND duration_ms IS NOT NULL
        GROUP BY queue
      `),
      db.execute(sql`
        SELECT name, (status = 'failed')::int AS failed
        FROM cronjobs
      `),
      // The latest allocation of each site with load management on (the log
      // gets a row only when the allocations change).
      db.execute(sql`
        SELECT
          count(*)::int AS enabled,
          count(*) FILTER (WHERE latest.total_draw_kw > latest.site_limit_kw)::int AS over_capacity,
          count(*) FILTER (WHERE slm.applied_at IS NULL)::int AS send_failed,
          COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - slm.applied_at))), 0)::float AS applied_age_max,
          COALESCE(SUM(latest.supply_credit_kw), 0)::float AS supply_credit_kw
        FROM site_load_management slm
        LEFT JOIN LATERAL (
          SELECT lal.total_draw_kw, lal.site_limit_kw, lal.supply_credit_kw
          FROM load_allocation_log lal
          WHERE lal.site_id = slm.site_id
          ORDER BY lal.created_at DESC
          LIMIT 1
        ) latest ON true
        WHERE slm.is_enabled = true
      `),
      db.execute(sql`
        SELECT COALESCE(readiness, 'unplanned') AS readiness, count(*)::int AS count
        FROM vehicle_departures
        WHERE status = 'scheduled'
        GROUP BY COALESCE(readiness, 'unplanned')
      `),
      db.execute(sql`
        SELECT kind, count(*)::int AS count
        FROM vehicle_departure_notices
        WHERE sent_at >= NOW() - INTERVAL '1 hour'
        GROUP BY kind
      `),
      db.execute(sql`
        SELECT outcome, count(*)::int AS count
        FROM vehicle_departures
        WHERE status = 'completed'
          AND outcome IS NOT NULL
          AND updated_at >= NOW() - INTERVAL '24 hours'
        GROUP BY outcome
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE stale_at < NOW() - INTERVAL '1 minute')::int AS stale,
          COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - stale_at))), 0)::float AS staleness_max,
          COALESCE(MAX(runtime_ms) FILTER (WHERE computed_at >= NOW() - INTERVAL '1 hour'), 0)::int AS runtime_max
        FROM site_charging_plans
      `),
      // Freshness as @evtivity/lib/energy-supply counts it: from the earlier
      // of the measured and the received time, for the asset's lifetime. Only
      // API telemetry stores readings: a simulated one is computed each cycle.
      db.execute(sql`
        SELECT a.type::text AS type,
          count(*)::int AS total,
          count(*) FILTER (
            WHERE a.telemetry = 'api'
              AND (a.connection_transformer_id IS NOT NULL OR a.connection_panel_id IS NOT NULL)
              AND (
                r.asset_id IS NULL
                OR LEAST(r.reported_at, r.received_at)
                  + make_interval(secs => a.reading_ttl_seconds) < NOW()
              )
          )::int AS stale
        FROM site_energy_assets a
        LEFT JOIN energy_asset_readings r ON r.asset_id = a.id
        GROUP BY a.type
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE is_enabled)::int AS enabled,
          count(*) FILTER (WHERE auth_locked_until > NOW())::int AS locked
        FROM depot_systems
      `),
      db.execute(sql`
        SELECT r.reason, count(*)::int AS count
        FROM depot_system_refused_requests r
        INNER JOIN depot_systems d ON d.id = r.depot_system_id
        WHERE d.is_enabled
        GROUP BY r.reason
      `),
      isVdv463Enabled(),
    ]);

    // Reset first, so a label that no longer has rows drops out.
    workerJobsLastHour.reset();
    for (const row of rows(jobRows)) {
      workerJobsLastHour.set(
        { queue: String(row['queue']), status: String(row['status']) },
        num(row, 'count'),
      );
    }
    workerJobDurationAvgMs.reset();
    workerJobDurationMaxMs.reset();
    for (const row of rows(durationRows)) {
      const queue = String(row['queue']);
      workerJobDurationAvgMs.set({ queue }, num(row, 'avg_ms'));
      workerJobDurationMaxMs.set({ queue }, num(row, 'max_ms'));
    }
    cronJobLastFailed.reset();
    for (const row of rows(cronRows)) {
      cronJobLastFailed.set({ name: String(row['name']) }, num(row, 'failed'));
    }

    const load = rows(loadRows)[0];
    loadManagementSitesEnabled.set(num(load, 'enabled'));
    loadManagementSitesOverCapacity.set(num(load, 'over_capacity'));
    loadManagementSitesSendFailed.set(num(load, 'send_failed'));
    loadManagementAppliedAgeMaxSeconds.set(num(load, 'applied_age_max'));
    loadManagementSupplyCreditKw.set(num(load, 'supply_credit_kw'));

    departuresScheduled.reset();
    for (const row of rows(departureRows)) {
      departuresScheduled.set({ readiness: String(row['readiness']) }, num(row, 'count'));
    }
    // Both kinds always export, so an alert on missed reads 0 instead of no data.
    departureNoticesLastHour.reset();
    departureNoticesLastHour.set({ kind: 'at_risk' }, 0);
    departureNoticesLastHour.set({ kind: 'missed' }, 0);
    for (const row of rows(noticeRows)) {
      departureNoticesLastHour.set({ kind: String(row['kind']) }, num(row, 'count'));
    }
    departuresCompletedLast24h.reset();
    for (const row of rows(outcomeRows)) {
      departuresCompletedLast24h.set({ outcome: String(row['outcome']) }, num(row, 'count'));
    }

    const plan = rows(planRows)[0];
    chargingPlansStale.set(num(plan, 'stale'));
    chargingPlanStalenessMaxSeconds.set(num(plan, 'staleness_max'));
    chargingPlanRuntimeMaxMs.set(num(plan, 'runtime_max'));

    energyAssetsTotal.reset();
    energyAssetsReadingStale.reset();
    for (const row of rows(assetRows)) {
      const type = String(row['type']);
      energyAssetsTotal.set({ type }, num(row, 'total'));
      energyAssetsReadingStale.set({ type }, num(row, 'stale'));
    }

    const depot = rows(depotRows)[0];
    depotInterfaceEnabled.set(interfaceOn ? 1 : 0);
    depotSystemsEnabled.set(num(depot, 'enabled'));
    depotSystemsAuthLocked.set(num(depot, 'locked'));
    depotSystemRefusedRequests.reset();
    for (const row of rows(refusedRows)) {
      depotSystemRefusedRequests.set({ reason: String(row['reason']) }, num(row, 'count'));
    }
  } catch (err) {
    // fail-open: the gauges keep their previous values until the next tick.
    logger.error(err, 'Failed to collect feature metrics');
  }
}
