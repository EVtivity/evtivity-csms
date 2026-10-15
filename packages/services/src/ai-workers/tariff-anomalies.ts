// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tariff anomalies (background AI worker `tariff_anomalies`): deterministic
 * findings over the sessions of the last 24 hours. Findings only: pricing,
 * billing and money writes are never proposed (TC-AI-WK-05).
 *
 * - `zero_cost` (ended in the window): a completed session that delivered
 *   energy, is not free vend, had a priced tariff and was billed nothing.
 * - `station_cost_mismatch` (ended in the window): the cost the station
 *   showed differs from the CSMS cost by at least `STATION_COST_TOLERANCE_CENTS`.
 * - `price_outlier` (started in the window): a price per kWh above
 *   `PRICE_OUTLIER_FACTOR` times the site's median of the last 30 days.
 * - `inactive_tariff` (started in the window): a session priced with a tariff
 *   that was already deactivated when the session started.
 *
 * Sessions of conformance test stations are never findings.
 */

import { client, operatorStationSql } from '@evtivity/database';

export const STATION_COST_TOLERANCE_CENTS = 50;
export const PRICE_OUTLIER_FACTOR = 3;
/** Session ids kept per finding, as evidence for the operator. */
export const FINDING_SAMPLE_SIZE = 5;

export const TARIFF_FINDING_TYPES = [
  'zero_cost',
  'station_cost_mismatch',
  'price_outlier',
  'inactive_tariff',
] as const;
export type TariffFindingType = (typeof TARIFF_FINDING_TYPES)[number];

export interface TariffFinding {
  type: TariffFindingType;
  count: number;
  sessionIds: string[];
}

interface FindingRow {
  type: TariffFindingType;
  count: number;
  session_ids: string[] | null;
}

/** The findings of one site, empty when nothing looks wrong. `now` bounds the window. */
export async function tariffAnomalies(input: {
  siteId: string;
  now: Date;
}): Promise<TariffFinding[]> {
  const rows = await client<FindingRow[]>`
    WITH window_sessions AS (
      SELECT s.*,
        s.started_at >= ${input.now}::timestamptz - interval '24 hours'
          AND s.started_at < ${input.now}::timestamptz AS started_in_window,
        s.ended_at >= ${input.now}::timestamptz - interval '24 hours'
          AND s.ended_at < ${input.now}::timestamptz AS ended_in_window
      FROM charging_sessions s
      JOIN charging_stations cs ON cs.id = s.station_id
      WHERE cs.site_id = ${input.siteId} AND ${client.unsafe(operatorStationSql('cs'))}
        AND (
          (s.started_at >= ${input.now}::timestamptz - interval '24 hours'
            AND s.started_at < ${input.now}::timestamptz)
          OR (s.ended_at >= ${input.now}::timestamptz - interval '24 hours'
            AND s.ended_at < ${input.now}::timestamptz)
        )
    ),
    site_median AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.tariff_price_per_kwh::numeric) AS median
      FROM charging_sessions s JOIN charging_stations cs ON cs.id = s.station_id
      WHERE cs.site_id = ${input.siteId} AND ${client.unsafe(operatorStationSql('cs'))}
        AND s.tariff_price_per_kwh::numeric > 0
        AND s.started_at >= ${input.now}::timestamptz - interval '30 days'
    ),
    findings AS (
      SELECT 'zero_cost' AS type, w.id, w.started_at FROM window_sessions w
      WHERE w.ended_in_window AND w.status = 'completed' AND COALESCE(w.energy_delivered_wh::numeric, 0) > 0
        AND NOT w.free_vend AND COALESCE(w.final_cost_cents, 0) = 0
        AND (COALESCE(w.tariff_price_per_kwh::numeric, 0) > 0
          OR COALESCE(w.tariff_price_per_minute::numeric, 0) > 0
          OR COALESCE(w.tariff_price_per_session::numeric, 0) > 0)
      UNION ALL
      SELECT 'station_cost_mismatch', w.id, w.started_at FROM window_sessions w
      WHERE w.ended_in_window
        AND abs(COALESCE(w.station_cost_difference_cents, 0)) >= ${STATION_COST_TOLERANCE_CENTS}
      UNION ALL
      SELECT 'price_outlier', w.id, w.started_at FROM window_sessions w CROSS JOIN site_median m
      WHERE w.started_in_window AND m.median IS NOT NULL AND m.median > 0
        AND w.tariff_price_per_kwh::numeric > m.median * ${PRICE_OUTLIER_FACTOR}
      UNION ALL
      SELECT 'inactive_tariff', w.id, w.started_at FROM window_sessions w
      JOIN tariffs t ON t.id = w.tariff_id
      WHERE w.started_in_window AND NOT t.is_active AND t.updated_at < w.started_at
    )
    SELECT type, count(*)::int AS count,
      (array_agg(id ORDER BY started_at DESC))[1:${FINDING_SAMPLE_SIZE}] AS session_ids
    FROM findings GROUP BY type ORDER BY type
  `;
  return rows.map((r) => ({ type: r.type, count: r.count, sessionIds: r.session_ids ?? [] }));
}
