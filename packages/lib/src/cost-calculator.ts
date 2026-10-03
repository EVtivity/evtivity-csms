// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { DEFAULT_TAX_BASIS, taxBreakdownByRate, taxLineForAmount } from './price-display.js';
import type {
  CostComponentGroup,
  CostTaxLine,
  SessionCostBreakdown,
  TaxBasis,
} from './price-display.js';

export interface TariffInput {
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
}

export interface CostBreakdown {
  /** The tax basis the prices were entered in. The dimension amounts below are in it. */
  basis: TaxBasis;
  energyCostCents: number;
  timeCostCents: number;
  sessionFeeCents: number;
  idleFeeCents: number;
  reservationHoldingFeeCents: number;
  /** Net amount (excluding tax) of everything billed. */
  subtotalCents: number;
  taxCents: number;
  /** Amount charged, tax included. */
  totalCents: number;
  /**
   * Amount of each cost dimension, net amount, and tax per tax rate, ordered
   * by rate. A session priced from one tariff has one line; a split-billed
   * session has one line per distinct segment tax rate. Their net amounts sum
   * to subtotalCents, their taxes to taxCents, and each dimension to its
   * total. Empty when nothing is billed.
   */
  taxLines: CostTaxLine[];
}

export interface SplitCostBreakdown extends CostBreakdown {
  /**
   * Cost of each segment, in segment order, after the grace period was
   * distributed and without the reservation holding fee. Each segment's tax
   * is computed once on its own amount at its tariff rate.
   */
  segments: CostBreakdown[];
  /** The reservation holding fee, taxed at the first segment's rate. */
  reservationHolding: CostTaxLine;
}

export interface TariffSegment {
  tariff: TariffInput;
  durationMinutes: number;
  energyDeliveredWh: number;
  idleMinutes: number;
  isFirstSegment: boolean;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)));
}

/** A tax line holding only a reservation holding fee (an amount in the basis). */
function reservationHoldingLine(
  amountCents: number,
  taxRate: number,
  basis: TaxBasis,
): CostTaxLine {
  const line = taxLineForAmount(amountCents, taxRate, basis);
  return {
    ...line,
    energyCostCents: 0,
    timeCostCents: 0,
    sessionFeeCents: 0,
    idleFeeCents: 0,
    reservationHoldingFeeCents: amountCents,
  };
}

/**
 * Cost of a session priced from one tariff. Each component is its quantity
 * times its price, rounded to the cent. On the 'net' basis (prices exclude
 * tax) the tax is the summed net amount times the rate, rounded once. On the
 * 'gross' basis (prices include tax) the components are gross amounts and the
 * tax contained in their sum is taken out once, so the amount charged is
 * exactly the sum of gross unit prices times quantities.
 */
export function calculateSessionCost(
  tariff: TariffInput,
  energyDeliveredWh: number,
  durationMinutes: number,
  idleMinutes: number = 0,
  gracePeriodMinutes: number = 0,
  reservationHoldingMinutes: number = 0,
  basis: TaxBasis = DEFAULT_TAX_BASIS,
): CostBreakdown {
  const energyKwh = energyDeliveredWh / 1000;
  const pricePerKwh = tariff.pricePerKwh != null ? Number(tariff.pricePerKwh) : 0;
  const pricePerMinute = tariff.pricePerMinute != null ? Number(tariff.pricePerMinute) : 0;
  const pricePerSession = tariff.pricePerSession != null ? Number(tariff.pricePerSession) : 0;
  const idleFeePricePerMinute =
    tariff.idleFeePricePerMinute != null ? Number(tariff.idleFeePricePerMinute) : 0;
  const reservationFeePerMinute =
    tariff.reservationFeePerMinute != null ? Number(tariff.reservationFeePerMinute) : 0;
  const taxRate = tariff.taxRate != null ? Number(tariff.taxRate) : 0;

  const energyCostCents = dollarsToCents(energyKwh * pricePerKwh);
  const timeCostCents = dollarsToCents(durationMinutes * pricePerMinute);
  const sessionFeeCents = dollarsToCents(pricePerSession);
  const billableIdleMinutes = Math.max(0, idleMinutes - gracePeriodMinutes);
  const idleFeeCents = dollarsToCents(billableIdleMinutes * idleFeePricePerMinute);
  const reservationHoldingFeeCents = dollarsToCents(
    reservationHoldingMinutes * reservationFeePerMinute,
  );
  const amountCents =
    energyCostCents + timeCostCents + sessionFeeCents + idleFeeCents + reservationHoldingFeeCents;
  const { netCents, taxCents } = taxLineForAmount(amountCents, taxRate, basis);

  return {
    basis,
    energyCostCents,
    timeCostCents,
    sessionFeeCents,
    idleFeeCents,
    reservationHoldingFeeCents,
    subtotalCents: netCents,
    taxCents,
    totalCents: netCents + taxCents,
    taxLines: taxBreakdownByRate([
      {
        taxRate,
        netCents,
        taxCents,
        energyCostCents,
        timeCostCents,
        sessionFeeCents,
        idleFeeCents,
        reservationHoldingFeeCents,
      },
    ]),
  };
}

export function calculateSplitSessionCost(
  segments: TariffSegment[],
  gracePeriodMinutes: number,
  reservationHoldingMinutes: number = 0,
  basis: TaxBasis = DEFAULT_TAX_BASIS,
): SplitCostBreakdown {
  if (segments.length === 0) {
    return {
      basis,
      energyCostCents: 0,
      timeCostCents: 0,
      sessionFeeCents: 0,
      idleFeeCents: 0,
      reservationHoldingFeeCents: 0,
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
      taxLines: [],
      segments: [],
      reservationHolding: reservationHoldingLine(0, 0, basis),
    };
  }

  // Apply grace period once across all segments. Distribute idle reduction
  // from last segment backward (idle typically accumulates at end of session).
  const totalIdleMinutes = segments.reduce((sum, s) => sum + s.idleMinutes, 0);
  const billableTotalIdle = Math.max(0, totalIdleMinutes - gracePeriodMinutes);
  let remainingReduction = totalIdleMinutes - billableTotalIdle;

  // Reduce idle from segments, starting from the last. Mapping over reversed
  // values (not indices) keeps each element non-nullable for the type checker.
  const adjustedSegments = [...segments]
    .reverse()
    .map((seg) => {
      const deduct = Math.min(seg.idleMinutes, remainingReduction);
      remainingReduction -= deduct;
      return { ...seg, idleMinutes: seg.idleMinutes - deduct };
    })
    .reverse();

  // Tax is applied per segment (not on the aggregate) so that sessions which
  // cross tariffs with different tax rates -- different jurisdictions,
  // tax-exempt promotional tariffs, peak-vs-off-peak rate differences -- are
  // billed at the rate that applied during each window. The session fee only
  // applies to the first segment. Grace was applied above.
  const segmentBreakdowns = adjustedSegments.map((segment) =>
    calculateSessionCost(
      segment.isFirstSegment ? segment.tariff : { ...segment.tariff, pricePerSession: null },
      segment.energyDeliveredWh,
      segment.durationMinutes,
      segment.idleMinutes,
      0,
      0,
      basis,
    ),
  );

  // Reservation holding fee is a session-level charge, not per-segment.
  // Use the first segment's tariff rate (tariff active at session start) and
  // tax it under that same first-segment rate for consistency with how the
  // session fee is treated.
  const firstTariff = segments[0]?.tariff;
  const reservationFeePerMinute =
    firstTariff?.reservationFeePerMinute != null ? Number(firstTariff.reservationFeePerMinute) : 0;
  const firstTaxRate = firstTariff?.taxRate != null ? Number(firstTariff.taxRate) : 0;
  const reservationHoldingFeeCents = dollarsToCents(
    reservationHoldingMinutes * reservationFeePerMinute,
  );
  const reservationHolding = reservationHoldingLine(
    reservationHoldingFeeCents,
    firstTaxRate,
    basis,
  );

  const sum = (pick: (b: CostBreakdown) => number): number =>
    segmentBreakdowns.reduce((total, b) => total + pick(b), 0);
  const subtotalCents = sum((b) => b.subtotalCents) + reservationHolding.netCents;
  const taxCents = sum((b) => b.taxCents) + reservationHolding.taxCents;

  return {
    basis,
    energyCostCents: sum((b) => b.energyCostCents),
    timeCostCents: sum((b) => b.timeCostCents),
    sessionFeeCents: sum((b) => b.sessionFeeCents),
    idleFeeCents: sum((b) => b.idleFeeCents),
    reservationHoldingFeeCents,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    taxLines: taxBreakdownByRate([
      ...segmentBreakdowns.flatMap((b) => b.taxLines),
      reservationHolding,
    ]),
    segments: segmentBreakdowns,
    reservationHolding,
  };
}

/** A tariff segment of a session as stored: its price snapshot and its window. */
export interface SessionSegmentInput {
  tariff: TariffInput;
  startedAt: Date;
  /** Null while the segment is open (the session is running in it). */
  endedAt: Date | null;
  energyWhStart: number;
  energyWhEnd: number | null;
  /** Idle minutes attributed to the segment when it closed. */
  idleMinutes: number;
}

/** Everything a session is priced from, at one moment. */
export interface SessionPricingInput {
  /** The tax basis the session's tariff prices were entered in. */
  basis: TaxBasis;
  /** The session's tariff snapshot, including its reservation fee. */
  tariff: TariffInput;
  startedAt: Date;
  /** The moment priced: the session end, or now for a running cost. */
  at: Date;
  /** Energy delivered at `at`, in Wh. */
  energyWh: number;
  /** Idle minutes of the whole session at `at`. */
  idleMinutes: number;
  gracePeriodMinutes: number;
  reservationHoldingMinutes: number;
  /**
   * The session's tariff segments in start order when split billing applies.
   * With more than one, each segment is priced from its own snapshot; with
   * one or none, the session snapshot prices the whole session.
   */
  segments: readonly SessionSegmentInput[];
}

/**
 * The cost of a session at a moment, from its price snapshots: the one
 * assembly of segments, idle time, grace period, and reservation holding fee
 * that the running cost, the final cost, and the TransactionEventResponse
 * totalCost all use.
 *
 * An open segment is priced as if it closed at `at` with `energyWh`, carrying
 * the session idle not yet attributed to closed segments, which is how the
 * session end closes it. The result is therefore the same before and after the
 * last segment is closed.
 */
export function calculateSessionCostAt(
  input: SessionPricingInput,
): CostBreakdown | SplitCostBreakdown {
  const { segments, at } = input;
  if (segments.length > 1) {
    const closedIdle = segments.reduce(
      (sum, seg) => (seg.endedAt != null ? sum + seg.idleMinutes : sum),
      0,
    );
    const openIdle = Math.max(0, input.idleMinutes - closedIdle);
    const tariffSegments: TariffSegment[] = segments.map((seg, index) => {
      const isOpen = seg.endedAt == null;
      const endMs = seg.endedAt != null ? seg.endedAt.getTime() : at.getTime();
      // A closed segment without an end reading counts as no energy rather
      // than a negative delta.
      const energyEnd = isOpen ? input.energyWh : (seg.energyWhEnd ?? seg.energyWhStart);
      return {
        tariff: seg.tariff,
        durationMinutes: (endMs - seg.startedAt.getTime()) / 60000,
        energyDeliveredWh: energyEnd - seg.energyWhStart,
        idleMinutes: isOpen ? openIdle : seg.idleMinutes,
        isFirstSegment: index === 0,
      };
    });
    return calculateSplitSessionCost(
      tariffSegments,
      input.gracePeriodMinutes,
      input.reservationHoldingMinutes,
      input.basis,
    );
  }

  return calculateSessionCost(
    input.tariff,
    input.energyWh,
    (at.getTime() - input.startedAt.getTime()) / 60000,
    input.idleMinutes,
    input.gracePeriodMinutes,
    input.reservationHoldingMinutes,
    input.basis,
  );
}

function isSplit(breakdown: CostBreakdown | SplitCostBreakdown): breakdown is SplitCostBreakdown {
  return 'segments' in breakdown;
}

/**
 * A calculated cost in the stored form (charging_sessions.cost_breakdown):
 * totals, tax lines per rate, and the components per tariff segment (a split
 * session's reservation holding fee as segment null), without empty groups.
 */
export function toSessionCostBreakdown(
  breakdown: CostBreakdown | SplitCostBreakdown,
): SessionCostBreakdown {
  const components: CostComponentGroup[] = isSplit(breakdown)
    ? [
        ...breakdown.segments.map((seg, i) => ({ segment: i + 1, taxLines: seg.taxLines })),
        { segment: null, taxLines: taxBreakdownByRate([breakdown.reservationHolding]) },
      ]
    : [{ segment: null, taxLines: breakdown.taxLines }];
  return {
    basis: breakdown.basis,
    netCents: breakdown.subtotalCents,
    taxCents: breakdown.taxCents,
    grossCents: breakdown.totalCents,
    taxLines: breakdown.taxLines.map(({ taxRate, netCents, taxCents }) => ({
      taxRate,
      netCents,
      taxCents,
    })),
    components: components.filter((group) => group.taxLines.length > 0),
  };
}
