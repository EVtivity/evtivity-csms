// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Session energy from cumulative energy register readings (finding B10).
//
// OCPP: a transaction's ".Register" values increase monotonically except when
// the meter is replaced (2.1 J02.FR.16 and MeasurandEnumType note 2, 1.6
// section 7.31), and the energy of a transaction is the register value minus
// the register value at its start (note 3). Readings can arrive out of order
// (an offline queue replayed after live readings) and a meter can be reset or
// replaced during a transaction. So:
//
// - A reading older than the newest projected register reading never changes
//   the session energy (it is already counted).
// - A reading at or after it that is below it is a register drop (reset or
//   replacement): the drop is added to the session's register offset, so the
//   energy delivered so far is kept and later readings add to it.
// - Session energy = register + offset - meter_start, never below 0 and never
//   lower than the energy already stored.

import type postgres from 'postgres';

export type RegisterReadingKind = 'first' | 'stale' | 'advance' | 'drop';

/** The register state of a session (charging_sessions columns of migration 0331). */
export interface SessionRegisterState {
  /** meter_start: the register at the start, null until the first reading (2.1). */
  meterStartWh: number | null;
  /** meter_register_offset_wh: the sum of every register drop so far. */
  offsetWh: number;
  /** meter_last_register_wh: the newest projected register reading. */
  lastRegisterWh: number | null;
  /** meter_last_register_at: its timestamp. */
  lastRegisterAt: Date | null;
  /** energy_delivered_wh. */
  energyWh: number | null;
}

export interface RegisterReadingResult {
  kind: RegisterReadingKind;
  meterStartWh: number;
  offsetWh: number;
  lastRegisterWh: number | null;
  lastRegisterAt: Date | null;
  energyWh: number;
}

/**
 * Applies one energy register reading (Wh) taken at `at` to a session's
 * register state. Pure: the caller stores the result. A rerun with the same
 * reading after its result was stored changes nothing (the reading is then
 * the newest one, equal to the stored register).
 */
export function applyRegisterReading(
  state: SessionRegisterState,
  reading: { registerWh: number; at: Date },
): RegisterReadingResult {
  const stored = state.energyWh ?? 0;
  if (state.meterStartWh == null) {
    // The first reading of a 2.1 transaction sets meter_start.
    const meterStartWh = Math.round(reading.registerWh);
    return {
      kind: 'first',
      meterStartWh,
      offsetWh: state.offsetWh,
      lastRegisterWh: reading.registerWh,
      lastRegisterAt: reading.at,
      energyWh: Math.max(stored, reading.registerWh + state.offsetWh - meterStartWh, 0),
    };
  }
  const meterStartWh = state.meterStartWh;
  if (state.lastRegisterAt != null && reading.at.getTime() < state.lastRegisterAt.getTime()) {
    return {
      kind: 'stale',
      meterStartWh,
      offsetWh: state.offsetWh,
      lastRegisterWh: state.lastRegisterWh,
      lastRegisterAt: state.lastRegisterAt,
      energyWh: stored,
    };
  }
  const baselineWh = state.lastRegisterWh ?? meterStartWh;
  const drop = reading.registerWh < baselineWh;
  const offsetWh = drop ? state.offsetWh + (baselineWh - reading.registerWh) : state.offsetWh;
  return {
    kind: drop ? 'drop' : 'advance',
    meterStartWh,
    offsetWh,
    lastRegisterWh: reading.registerWh,
    lastRegisterAt: reading.at,
    energyWh: Math.max(stored, reading.registerWh + offsetWh - meterStartWh, 0),
  };
}

/** The register state columns of a charging_sessions row. */
export function registerStateFromRow(row: Record<string, unknown>): SessionRegisterState {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const at = row.meter_last_register_at;
  return {
    meterStartWh: num(row.meter_start),
    offsetWh: num(row.meter_register_offset_wh) ?? 0,
    lastRegisterWh: num(row.meter_last_register_wh),
    lastRegisterAt: at == null ? null : at instanceof Date ? at : new Date(at as string),
    energyWh: num(row.energy_delivered_wh),
  };
}

export interface SessionEnergyUpdate extends RegisterReadingResult {
  /** energy_delivered_wh before the reading (null when it was unset). */
  previousEnergyWh: number | null;
}

/**
 * Applies an energy register reading to an active session under its row lock
 * (applyRegisterReading), and stores meter_start (first reading), the energy,
 * the register offset and the newest register reading. energy_rose_at moves
 * to the reading when it raised the energy by 1 Wh or more (the flat-energy
 * idle fallback). Null when the session is not active.
 */
export async function applySessionEnergyReading(
  sql: postgres.Sql,
  params: { sessionId: string; registerWh: number; at: Date },
): Promise<SessionEnergyUpdate | null> {
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    const [row] = await txSql`
      SELECT meter_start, meter_register_offset_wh, meter_last_register_wh,
             meter_last_register_at, energy_delivered_wh
      FROM charging_sessions
      WHERE id = ${params.sessionId} AND status = 'active'
      FOR UPDATE
    `;
    if (row == null) return null;
    const state = registerStateFromRow(row);
    const result = applyRegisterReading(state, {
      registerWh: params.registerWh,
      at: params.at,
    });
    if (result.kind !== 'stale') {
      const atIso = params.at.toISOString();
      const rose = result.energyWh - (state.energyWh ?? 0) >= 1;
      await txSql`
        UPDATE charging_sessions
        SET meter_start = ${result.meterStartWh},
            meter_register_offset_wh = ${result.offsetWh},
            meter_last_register_wh = ${result.lastRegisterWh},
            meter_last_register_at = ${atIso},
            energy_delivered_wh = ${result.energyWh},
            energy_rose_at = CASE
              WHEN ${rose} THEN GREATEST(COALESCE(energy_rose_at, ${atIso}::timestamptz), ${atIso}::timestamptz)
              ELSE energy_rose_at
            END,
            updated_at = now()
        WHERE id = ${params.sessionId}
      `;
    }
    return { ...result, previousEnergyWh: state.energyWh };
  });
}
