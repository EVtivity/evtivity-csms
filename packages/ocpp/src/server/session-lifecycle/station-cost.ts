// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { centsFromMajorUnits } from '@evtivity/lib';
import type { Logger } from '@evtivity/lib';

// OCPP 2.1 local cost calculation: a station with a TariffType reports the
// tariff it applies (transactionInfo.tariffId, I08.FR.22, I11.FR.07) and its
// calculated cost (costDetails, I12.FR.01 to FR.03). The CSMS bills its own
// cost (the one cost assembly); this records what the station calculated and,
// at the end, how far it is from the billed final cost, so a station that
// shows the driver a different amount is visible in the logs.

/**
 * The difference above which the station's total is logged: 1% of the billed
 * cost, at least 2 cents. Stations round per charging period and the CSMS per
 * session, so a cent or two apart is expected.
 */
export function stationCostTolerance(billedCents: number): number {
  return Math.max(2, Math.ceil(Math.abs(billedCents) * 0.01));
}

export interface StationReportedCost {
  /** totalCost.total in cents: including tax when the station sent inclTax, else excluding it. */
  cents: number;
  includesTax: boolean;
  currency: string | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The station's total from CostDetailsType.totalCost.total, in cents. Null
 * when the station could not calculate it (failureToCalculate, I12.FR.14) or
 * sent no amount.
 */
export function stationReportedCost(costDetails: unknown): StationReportedCost | null {
  if (costDetails == null || typeof costDetails !== 'object') return null;
  const details = costDetails as Record<string, unknown>;
  if (details['failureToCalculate'] === true) return null;
  const totalCost = details['totalCost'] as Record<string, unknown> | undefined;
  const total = totalCost?.['total'] as Record<string, unknown> | undefined;
  const inclTax = num(total?.['inclTax']);
  const exclTax = num(total?.['exclTax']);
  const amount = inclTax ?? exclTax;
  if (amount == null) return null;
  const currency = totalCost?.['currency'];
  return {
    cents: centsFromMajorUnits(amount),
    includesTax: inclTax != null,
    currency: typeof currency === 'string' ? currency.toUpperCase() : null,
  };
}

/**
 * Stores the tariffId and cost details a TransactionEvent carried on its
 * session. On Ended (after the final cost was stored), compares the station's
 * total with the billed final cost (gross, or net when the station sent no
 * inclTax), stores the difference, and logs it at warn above the tolerance.
 * Recoverable (P9): the session is billed either way, so a failure is logged.
 */
export async function recordStationCost(
  sql: postgres.Sql,
  logger: Logger,
  event: {
    stationUuid: string;
    transactionId: string;
    eventType: string;
    stationTariffId: string | null;
    costDetails: unknown;
  },
): Promise<void> {
  if (event.stationTariffId == null && event.costDetails == null) return;
  const reported = stationReportedCost(event.costDetails);
  try {
    const details = event.costDetails != null ? JSON.stringify(event.costDetails) : null;
    const [session] = await sql<
      Array<{
        id: string;
        final_cost_cents: number | null;
        net_cents: number | null;
        currency: string | null;
      }>
    >`
      UPDATE charging_sessions
      SET station_tariff_id = COALESCE(${event.stationTariffId}, station_tariff_id),
          station_cost_details = COALESCE(${details}::jsonb, station_cost_details),
          station_cost_cents = COALESCE(${reported?.cents ?? null}::integer, station_cost_cents),
          updated_at = now()
      WHERE station_id = ${event.stationUuid} AND transaction_id = ${event.transactionId}
      RETURNING id, final_cost_cents, net_cents, currency
    `;
    if (session == null || event.eventType !== 'Ended' || reported == null) return;
    const billed = reported.includesTax ? session.final_cost_cents : session.net_cents;
    if (billed == null) return;
    const currency = session.currency?.toUpperCase() ?? null;
    if (reported.currency != null && currency != null && reported.currency !== currency) {
      logger.warn(
        { sessionId: session.id, stationCurrency: reported.currency, currency },
        'Station cost details are in another currency than the session; not compared',
      );
      return;
    }
    const difference = reported.cents - billed;
    await sql`
      UPDATE charging_sessions SET station_cost_difference_cents = ${difference}
      WHERE id = ${session.id}
    `;
    if (Math.abs(difference) > stationCostTolerance(billed)) {
      logger.warn(
        {
          sessionId: session.id,
          stationCostCents: reported.cents,
          billedCents: billed,
          differenceCents: difference,
          includesTax: reported.includesTax,
        },
        'Station-calculated cost differs from the billed cost',
      );
    }
  } catch (err) {
    logger.warn(
      { err, stationUuid: event.stationUuid, transactionId: event.transactionId },
      'Failed to record the station-calculated cost',
    );
  }
}
