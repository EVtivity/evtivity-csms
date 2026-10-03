// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { priceSessionAt } from '@evtivity/database';

/** The cost of a transaction at a moment of its TransactionEvent. */
export interface TransactionCost {
  /** Cost in cents of the session currency. */
  totalCostCents: number;
  /**
   * True when priced from the session's tariff snapshot by the one cost
   * assembly (`priceSessionAt`, which the Ended projection also stores the
   * final cost with). False when the session is not billed (no tariff, free
   * vend, or already faulted or failed).
   */
  calculated: boolean;
}

/**
 * The cost of the session of `transactionId` at `stationId` at `at`, for the
 * 2.1 TransactionEventResponse totalCost: the running cost for Started and
 * Updated (I02 alternative scenario), the final cost for Ended (I03.FR.02).
 * The caller first waits for the projections the session row depends on. The
 * energy is the one the projections store: the register reading of the event
 * (`meterRegisterWh`) minus meter_start when that is higher than the energy
 * from earlier readings. Returns null when the session is unknown (its
 * Started event has not been projected), so the cost is not known.
 */
export async function transactionCostAt(
  sql: postgres.Sql,
  params: { stationId: string; transactionId: string; at: Date; meterRegisterWh: number | null },
): Promise<TransactionCost | null> {
  const rows = await sql`
    SELECT s.id, s.status, s.tariff_id, s.energy_delivered_wh, s.meter_start, s.final_cost_cents
    FROM charging_sessions s
    JOIN charging_stations st ON st.id = s.station_id
    WHERE st.station_id = ${params.stationId} AND s.transaction_id = ${params.transactionId}
    LIMIT 1
  `;
  const session = rows[0];
  if (session == null) return null;

  const status = session.status as string;
  if (status === 'faulted' || status === 'failed') {
    // The payment gate or another stop path already ended the session without
    // charging it (P5: a later event does not bill it).
    return {
      totalCostCents: Number(session.final_cost_cents ?? 0),
      calculated: false,
    };
  }
  // No tariff snapshot (no pricing for this station, or a free vend site):
  // the session is not billed, which the spec reports as 0.00 (I03.FR.04).
  if (session.tariff_id == null) return { totalCostCents: 0, calculated: false };

  const storedEnergyWh = Number(session.energy_delivered_wh ?? 0);
  const meterStart = session.meter_start != null ? Number(session.meter_start) : null;
  const energyWh =
    params.meterRegisterWh != null && meterStart != null && params.meterRegisterWh >= meterStart
      ? Math.max(storedEnergyWh, params.meterRegisterWh - meterStart)
      : storedEnergyWh;

  const breakdown = await priceSessionAt(sql, session.id as string, params.at, energyWh);
  if (breakdown == null) return { totalCostCents: 0, calculated: false };
  return { totalCostCents: breakdown.grossCents, calculated: true };
}
