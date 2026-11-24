// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { phasesFromReadings } from '@evtivity/lib/ev-phases';
import type { EvPhases } from '@evtivity/lib/ev-phases';

/**
 * Stores the phases a reading showed on the matched session, else the active
 * session of the EVSE. Only an active session, and only when the value differs.
 */
export async function recordSessionPhases(
  sql: postgres.Sql,
  params: {
    stationUuid: string;
    sessionId: string | null;
    evseUuid: string | null;
    phases: EvPhases;
  },
): Promise<boolean> {
  if (params.sessionId == null && params.evseUuid == null) return false;
  const rows = await sql`
    UPDATE charging_sessions
    SET ev_phases = ${params.phases}, updated_at = now()
    WHERE station_id = ${params.stationUuid}
      AND status = 'active'
      AND (id = ${params.sessionId}
        OR (${params.sessionId}::text IS NULL AND evse_id = ${params.evseUuid}))
      AND ev_phases IS DISTINCT FROM ${params.phases}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * A station's numberOfPhasesUsed of 3 names all three phases while no reading
 * told them; a per-phase reading always wins.
 */
export async function recordReportedPhaseCount(
  sql: postgres.Sql,
  stationUuid: string,
  transactionId: string,
  numberOfPhasesUsed: number,
): Promise<boolean> {
  const phases = phasesFromReadings([], numberOfPhasesUsed);
  if (phases == null) return false;
  const rows = await sql`
    UPDATE charging_sessions
    SET ev_phases = ${phases}, updated_at = now()
    WHERE station_id = ${stationUuid}
      AND transaction_id = ${transactionId}
      AND status = 'active'
      AND ev_phases IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}
