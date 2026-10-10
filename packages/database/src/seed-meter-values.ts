// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

/** A demo meter reading of a seeded session (no EVSE, no phase). */
export interface DemoMeterValueRow {
  stationId: string;
  sessionId: string;
  timestamp: Date;
  measurand: string;
  unit: string;
  value: string;
  context: string;
  location: string;
}

const BATCH_SIZE = 500;

/**
 * Inserts the demo meter values in batches. Two random sample times of one
 * session can coincide on the same measurand, and meter_values_dedup_idx
 * (migration 0044, NULLS NOT DISTINCT) keeps one row per (session, EVSE,
 * timestamp, measurand, phase, location), so a duplicate is skipped the way
 * the OCPP insert path skips a retransmit (P7). Returns the rows inserted.
 */
export async function insertDemoMeterValues(
  sql: postgres.Sql,
  rows: readonly DemoMeterValueRow[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((r) => ({
      station_id: r.stationId,
      session_id: r.sessionId,
      timestamp: r.timestamp,
      measurand: r.measurand,
      unit: r.unit,
      value: r.value,
      context: r.context,
      location: r.location,
    }));
    const result = await sql`
      INSERT INTO meter_values ${sql(batch)}
      ON CONFLICT (session_id, evse_id, timestamp, measurand, phase, location) DO NOTHING
    `;
    inserted += result.count;
  }
  return inserted;
}
