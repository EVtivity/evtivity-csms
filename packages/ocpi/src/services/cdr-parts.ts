// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The priced parts of a session for its CDR: the whole session when one
// tariff priced it, else each tariff segment, with the prices the session was
// billed at (the session and segment price snapshots, never the editable
// tariff row), the energy, the charging and idle minutes, and the idle minutes
// the idle fee was billed for. The CDR reads its charging periods, its
// per-dimension costs (pricing engine) and its embedded tariffs from them.

import { asc, eq } from 'drizzle-orm';
import { db, sessionTariffSegments, tariffs } from '@evtivity/database';
import { parseSessionCostBreakdown } from '@evtivity/lib/price-display';
import type { ComponentTime } from '@evtivity/lib/pricing-engine';
import type { CdrPeriodSource } from '../lib/charging-periods.js';
import type { TariffSource } from '../transformers/tariff.transformer.js';
import { idleMinutesAt } from './session-cost-split.js';
import type { SessionCostSource } from './session-cost-split.js';

/** The `charging_sessions` columns the CDR parts read. */
export interface CdrSessionSource extends SessionCostSource {
  startedAt: Date | null;
  endedAt: Date | null;
  energyDeliveredWh: string | null;
  tariffId: string | null;
  tariffPricePerKwh: string | null;
  tariffPricePerMinute: string | null;
  tariffPricePerSession: string | null;
  tariffIdleFeePricePerMinute: string | null;
  tariffReservationFeePerMinute: string | null;
}

/** One priced part: its CDR period source, its billed prices, and its breakdown component. */
export interface CdrPart {
  /** The breakdown component (segment number), null for a session priced from one tariff. */
  segment: number | null;
  /** The internal tariff the part was billed with (its price snapshot below). */
  tariffId: string | null;
  prices: TariffSource;
  period: Omit<CdrPeriodSource, 'tariffId'>;
}

function num(value: string | null | undefined): number {
  const parsed = value != null ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshot(
  id: string,
  p: {
    pricePerKwh: string | null;
    pricePerMinute: string | null;
    pricePerSession: string | null;
    idleFeePricePerMinute: string | null;
    reservationFeePerMinute: string | null;
    taxRate: string | null;
  },
): TariffSource {
  return { id, ...p, restrictions: null, priority: 0, isDefault: true, isActive: true };
}

/**
 * Idle minutes billed the idle fee: the breakdown component's
 * billableIdleMinutes; 0 when the part has an idle fee but none was billed
 * (all idle within the grace); null without an idle fee.
 */
function billable(prices: TariffSource, recorded: number | undefined): number | null {
  if (recorded != null) return recorded;
  return num(prices.idleFeePricePerMinute) > 0 ? 0 : null;
}

/** The priced parts of a completed session; empty without a start and end. */
export async function sessionCdrParts(
  session: CdrSessionSource & { id: string },
): Promise<CdrPart[]> {
  if (session.startedAt == null || session.endedAt == null) return [];
  const breakdown = parseSessionCostBreakdown(session.costBreakdown);
  const components = breakdown?.components ?? [];
  const split = components.some((c) => c.segment != null);

  if (!split) {
    const prices = snapshot(session.tariffId ?? 'session', {
      pricePerKwh: session.tariffPricePerKwh,
      pricePerMinute: session.tariffPricePerMinute,
      pricePerSession: session.tariffPricePerSession,
      idleFeePricePerMinute: session.tariffIdleFeePricePerMinute,
      reservationFeePerMinute: session.tariffReservationFeePerMinute,
      taxRate: session.tariffTaxRate,
    });
    const totalMinutes =
      Math.max(0, session.endedAt.getTime() - session.startedAt.getTime()) / 60_000;
    const idle = Math.min(totalMinutes, idleMinutesAt(session, session.endedAt));
    return [
      {
        segment: null,
        tariffId: session.tariffId,
        prices,
        period: {
          startedAt: session.startedAt,
          kwh: num(session.energyDeliveredWh) / 1000,
          chargingMinutes: totalMinutes - idle,
          idleMinutes: idle,
          billableIdleMinutes: billable(prices, components[0]?.billableIdleMinutes),
        },
      },
    ];
  }

  const rows = await db
    .select({
      tariffId: sessionTariffSegments.tariffId,
      startedAt: sessionTariffSegments.startedAt,
      endedAt: sessionTariffSegments.endedAt,
      energyWhStart: sessionTariffSegments.energyWhStart,
      energyWhEnd: sessionTariffSegments.energyWhEnd,
      durationMinutes: sessionTariffSegments.durationMinutes,
      idleMinutes: sessionTariffSegments.idleMinutes,
      priceSnapshot: sessionTariffSegments.priceSnapshot,
      pricePerKwh: sessionTariffSegments.pricePerKwh,
      pricePerMinute: sessionTariffSegments.pricePerMinute,
      pricePerSession: sessionTariffSegments.pricePerSession,
      idleFeePricePerMinute: sessionTariffSegments.idleFeePricePerMinute,
      reservationFeePerMinute: sessionTariffSegments.reservationFeePerMinute,
      taxRate: sessionTariffSegments.taxRate,
      tariffPricePerKwh: tariffs.pricePerKwh,
      tariffPricePerMinute: tariffs.pricePerMinute,
      tariffPricePerSession: tariffs.pricePerSession,
      tariffIdleFeePricePerMinute: tariffs.idleFeePricePerMinute,
      tariffReservationFeePerMinute: tariffs.reservationFeePerMinute,
      tariffTaxRate: tariffs.taxRate,
    })
    .from(sessionTariffSegments)
    .leftJoin(tariffs, eq(tariffs.id, sessionTariffSegments.tariffId))
    .where(eq(sessionTariffSegments.sessionId, session.id))
    .orderBy(asc(sessionTariffSegments.startedAt), asc(sessionTariffSegments.id));

  const endedAt = session.endedAt;
  return rows.map((row, index) => {
    // Rows from before migration 0111 (price_snapshot false) were billed from their tariff.
    const prices = snapshot(
      row.tariffId,
      row.priceSnapshot
        ? {
            pricePerKwh: row.pricePerKwh,
            pricePerMinute: row.pricePerMinute,
            pricePerSession: row.pricePerSession,
            idleFeePricePerMinute: row.idleFeePricePerMinute,
            reservationFeePerMinute: row.reservationFeePerMinute,
            taxRate: row.taxRate,
          }
        : {
            pricePerKwh: row.tariffPricePerKwh,
            pricePerMinute: row.tariffPricePerMinute,
            pricePerSession: row.tariffPricePerSession,
            idleFeePricePerMinute: row.tariffIdleFeePricePerMinute,
            reservationFeePerMinute: row.tariffReservationFeePerMinute,
            taxRate: row.tariffTaxRate,
          },
    );
    const end = row.endedAt ?? endedAt;
    const duration =
      row.durationMinutes != null
        ? num(row.durationMinutes)
        : Math.max(0, end.getTime() - row.startedAt.getTime()) / 60_000;
    const idle = Math.min(duration, num(row.idleMinutes));
    const segment = index + 1;
    return {
      segment,
      tariffId: row.tariffId,
      prices,
      period: {
        startedAt: row.startedAt,
        kwh: Math.max(0, num(row.energyWhEnd ?? row.energyWhStart) - num(row.energyWhStart)) / 1000,
        chargingMinutes: duration - idle,
        idleMinutes: idle,
        billableIdleMinutes: billable(
          prices,
          components.find((c) => c.segment === segment)?.billableIdleMinutes,
        ),
      },
    };
  });
}

/** The charging and idle minutes of each part, for the engine's time split. */
export function partTimes(parts: readonly CdrPart[]): ComponentTime[] {
  return parts.map((part) => ({
    segment: part.segment,
    chargingMinutes: part.period.chargingMinutes,
    idleMinutes: part.period.idleMinutes,
  }));
}
