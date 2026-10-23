// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The per-session meter summary: the peak active import power and the last
// state of charge, kept on charging_sessions because meter_values is pruned
// after logs.meterValues.retentionDays. Session-level readers (the NEVI
// report, the portal session detail) read these columns, never the pruned rows.

import type postgres from 'postgres';

export interface SessionMeterSummaryReading {
  /** The highest overall Outlet Power.Active.Import of the delivery, in W. */
  peakPowerW: number | null;
  /** The state of charge of the newest reading of the delivery that has one. */
  socPercent: number | null;
  /** That reading's timestamp. */
  socAt: Date | null;
}

/**
 * Applies the summary of one MeterValues delivery to its session, in one
 * guarded UPDATE: the peak only rises, and the state of charge moves only to
 * a reading newer than the stored one, so a late or replayed reading never
 * lowers the peak or moves the state of charge back. The target is the
 * matched session in any status (a reading can arrive after the end), else
 * the active session of the EVSE. Returns whether a row changed.
 */
export async function applySessionMeterSummary(
  sql: postgres.Sql,
  params: {
    stationUuid: string;
    sessionId: string | null;
    evseUuid: string | null;
    reading: SessionMeterSummaryReading;
  },
): Promise<boolean> {
  const { peakPowerW } = params.reading;
  const socPercent = params.reading.socAt == null ? null : params.reading.socPercent;
  // At most now: a station clock running ahead must not store a future time,
  // which would hold back every later state of charge of the session.
  const readingAt = params.reading.socAt;
  const socAt =
    socPercent == null || readingAt == null
      ? null
      : new Date(Math.min(readingAt.getTime(), Date.now())).toISOString();
  if (peakPowerW == null && socAt == null) return false;
  if (params.sessionId == null && params.evseUuid == null) return false;
  const rows = await sql`
    UPDATE charging_sessions
    SET peak_power_w = CASE
          WHEN ${peakPowerW}::numeric IS NOT NULL
            AND (peak_power_w IS NULL OR ${peakPowerW}::numeric > peak_power_w)
          THEN ${peakPowerW}::numeric
          ELSE peak_power_w
        END,
        last_soc_percent = CASE
          WHEN ${socAt}::timestamptz IS NOT NULL
            AND (last_soc_at IS NULL OR ${socAt}::timestamptz > last_soc_at)
          THEN ${socPercent}::numeric
          ELSE last_soc_percent
        END,
        last_soc_at = CASE
          WHEN ${socAt}::timestamptz IS NOT NULL
            AND (last_soc_at IS NULL OR ${socAt}::timestamptz > last_soc_at)
          THEN ${socAt}::timestamptz
          ELSE last_soc_at
        END,
        updated_at = now()
    WHERE station_id = ${params.stationUuid}
      AND (id = ${params.sessionId}
        OR (${params.sessionId}::text IS NULL AND evse_id = ${params.evseUuid} AND status = 'active'))
      AND (
        (${peakPowerW}::numeric IS NOT NULL
          AND (peak_power_w IS NULL OR ${peakPowerW}::numeric > peak_power_w))
        OR (${socAt}::timestamptz IS NOT NULL
          AND (last_soc_at IS NULL OR ${socAt}::timestamptz > last_soc_at))
      )
    RETURNING id
  `;
  return rows.length > 0;
}
