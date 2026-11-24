// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { circuitConductorPhases, effectiveCircuitVoltageV, evseChargingKind } from '@evtivity/lib';
import { acSessionKwAt, parseAppliedAllocations } from './load-management.service.js';

/** What the cap of one session's TxProfile is read from. */
export interface SessionProfileCapInput {
  transactionId: string;
  stationDbId: string;
  kind: 'ac' | 'dc' | null;
  evPhases: string | null;
  /** The tariff current limit in force: the open segment's, else the session's; A per phase. */
  tariffMaxCurrentA: number | null;
  circuit: {
    voltageV: number | null;
    phaseConnections: string | null;
    panelVoltageV: number;
    panelPhases: number;
  } | null;
  loadManagementEnabled: boolean;
  appliedAllocations: unknown;
}

/**
 * The most another TxProfile of the session may allow, kW: the tariff current
 * limit of an AC session at its circuit and phases, and the EVSE limit load
 * management holds for the transaction. Null when neither applies.
 */
export function sessionProfileCapKwFrom(input: SessionProfileCapInput): number | null {
  const caps: number[] = [];
  if (input.kind !== 'dc' && input.tariffMaxCurrentA != null && input.circuit != null) {
    const kw = acSessionKwAt(
      {
        circuitVoltageV: effectiveCircuitVoltageV(
          input.circuit.voltageV,
          input.circuit.panelVoltageV,
          input.circuit.panelPhases,
        ),
        circuitPhases: circuitConductorPhases(
          input.circuit.phaseConnections,
          input.circuit.panelPhases,
        ),
      },
      input.evPhases,
      input.tariffMaxCurrentA,
    );
    if (kw != null) caps.push(kw);
  }
  if (input.loadManagementEnabled) {
    const station = (parseAppliedAllocations(input.appliedAllocations) ?? []).find(
      (a) => a.stationDbId === input.stationDbId,
    );
    const evse = station?.evses?.find((e) => e.transactionId === input.transactionId);
    if (evse != null && Number.isFinite(evse.limitKw)) caps.push(Math.max(0, evse.limitKw));
  }
  return caps.length > 0 ? Math.min(...caps) : null;
}

const positive = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Reads `sessionProfileCapKwFrom` for the active session of a transaction at a station. */
export async function sessionProfileCapKw(
  stationUuid: string,
  transactionId: string,
): Promise<number | null> {
  const rows = await client`
    SELECT s.charging_kind, s.ev_phases, s.tariff_max_current_a, s.evse_id,
      seg.id AS segment_id, seg.max_current_a AS segment_max_current_a,
      c.voltage_v AS circuit_voltage_v, c.phase_connections,
      p.voltage_v AS panel_voltage_v, p.phases AS panel_phases,
      slm.is_enabled, slm.applied_allocations
    FROM charging_sessions s
    JOIN charging_stations st ON st.id = s.station_id
    LEFT JOIN session_tariff_segments seg ON seg.session_id = s.id AND seg.ended_at IS NULL
    LEFT JOIN circuits c ON c.id = st.circuit_id
    LEFT JOIN panels p ON p.id = c.panel_id
    LEFT JOIN site_load_management slm ON slm.site_id = st.site_id
    WHERE s.station_id = ${stationUuid} AND s.transaction_id = ${transactionId}
      AND s.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (row == null) return null;
  const storedKind = row.charging_kind as string | null;
  let kind: 'ac' | 'dc' | null = storedKind === 'ac' || storedKind === 'dc' ? storedKind : null;
  if (kind == null && row.evse_id != null) {
    const connectorRows = await client`
      SELECT connector_type, max_power_kw FROM connectors WHERE evse_id = ${row.evse_id as string}
    `;
    const evseKind = evseChargingKind(
      connectorRows.map((c) => ({
        connectorType: (c.connector_type as string | null) ?? null,
        maxPowerKw: (c.max_power_kw as string | null) ?? null,
      })),
    );
    kind = evseKind === 'dc' ? 'dc' : 'ac';
  }
  return sessionProfileCapKwFrom({
    transactionId,
    stationDbId: stationUuid,
    kind,
    evPhases: (row.ev_phases as string | null) ?? null,
    tariffMaxCurrentA: positive(
      row.segment_id != null ? row.segment_max_current_a : row.tariff_max_current_a,
    ),
    circuit:
      row.panel_voltage_v == null || row.panel_phases == null
        ? null
        : {
            voltageV: (row.circuit_voltage_v as number | null) ?? null,
            phaseConnections: (row.phase_connections as string | null) ?? null,
            panelVoltageV: Number(row.panel_voltage_v),
            panelPhases: Number(row.panel_phases),
          },
    loadManagementEnabled: row.is_enabled === true,
    appliedAllocations: row.applied_allocations,
  });
}
