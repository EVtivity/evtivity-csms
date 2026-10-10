// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  DEFAULT_TAX_BASIS,
  taxBreakdownByRate,
  taxLineForAmount,
  taxPerRate,
} from './price-display.js';
import type {
  CostComponentGroup,
  CostTaxLine,
  SessionCostBreakdown,
  TaxBasis,
  TaxLine,
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
  /**
   * Idle minutes billed (after the grace period) when an idle fee was
   * charged. Absent when no idle fee was billed.
   */
  billableIdleMinutes?: number;
}

export interface SplitCostBreakdown extends CostBreakdown {
  /**
   * Cost of each segment, in segment order, after the grace period was
   * taken from the first idle minutes and without the reservation holding fee. Tax is rounded once
   * per rate over all segments (and the holding fee) at that rate; each
   * segment carries its share of it, in proportion to its amount.
   */
  segments: CostBreakdown[];
  /** The reservation holding fee, taxed with the first segment's rate (its share of that rate's tax). */
  reservationHolding: CostTaxLine;
}

export interface TariffSegment {
  tariff: TariffInput;
  durationMinutes: number;
  energyDeliveredWh: number;
  idleMinutes: number;
  isFirstSegment: boolean;
}

/**
 * A cost calculator input that cannot be priced: a quantity (energy, minutes)
 * or a tariff price that is not a finite number at or above 0. The calculator
 * refuses it instead of billing a negative or NaN amount (design principle
 * P9: a billing input error is not recoverable). Callers pass non-negative
 * quantities; this error means the data feeding them is wrong.
 */
export class CostInputError extends RangeError {
  readonly field: string;
  readonly value: unknown;

  constructor(field: string, value: unknown) {
    super(`Cost input ${field} must be a finite number at or above 0, got ${String(value)}`);
    this.name = 'CostInputError';
    this.field = field;
    this.value = value;
  }
}

/** A quantity checked to be a finite number at or above 0. */
function quantity(field: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CostInputError(field, value);
  }
  return value;
}

/** A stored tariff price (decimal string) as a number, 0 when absent; refused when invalid. */
function price(field: keyof TariffInput, value: string | null): number {
  if (value == null) return 0;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new CostInputError(`tariff.${field}`, value);
  return parsed;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toPrecision(12)));
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
  const energyKwh = quantity('energyDeliveredWh', energyDeliveredWh) / 1000;
  quantity('durationMinutes', durationMinutes);
  quantity('idleMinutes', idleMinutes);
  quantity('gracePeriodMinutes', gracePeriodMinutes);
  quantity('reservationHoldingMinutes', reservationHoldingMinutes);
  const pricePerKwh = price('pricePerKwh', tariff.pricePerKwh);
  const pricePerMinute = price('pricePerMinute', tariff.pricePerMinute);
  const pricePerSession = price('pricePerSession', tariff.pricePerSession);
  const idleFeePricePerMinute = price('idleFeePricePerMinute', tariff.idleFeePricePerMinute);
  const reservationFeePerMinute = price('reservationFeePerMinute', tariff.reservationFeePerMinute);
  const taxRate = price('taxRate', tariff.taxRate);

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
    ...(idleFeeCents > 0 ? { billableIdleMinutes } : {}),
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
      reservationHolding: {
        taxRate: 0,
        netCents: 0,
        taxCents: 0,
        energyCostCents: 0,
        timeCostCents: 0,
        sessionFeeCents: 0,
        idleFeeCents: 0,
        reservationHoldingFeeCents: 0,
      },
    };
  }

  quantity('gracePeriodMinutes', gracePeriodMinutes);
  quantity('reservationHoldingMinutes', reservationHoldingMinutes);
  segments.forEach((seg, i) => {
    quantity(`segments[${String(i)}].idleMinutes`, seg.idleMinutes);
  });

  // The grace period is the first idle minutes of the session (owner
  // decision 2026-10-09): it is taken once, from the first segment forward,
  // so the free minutes are the same whether or not the session was split.
  let remainingGrace = gracePeriodMinutes;
  const adjustedSegments = segments.map((seg) => {
    const deduct = Math.min(seg.idleMinutes, remainingGrace);
    remainingGrace -= deduct;
    return { ...seg, idleMinutes: seg.idleMinutes - deduct };
  });

  // Each segment is billed at its own tariff's rate, so sessions which cross
  // tariffs with different tax rates -- different jurisdictions, tax-exempt
  // promotional tariffs -- are taxed at the rate that applied during each
  // window. The session fee only applies to the first segment. Grace was
  // applied above. The segment amounts are taxed below, once per rate.
  const segmentAmounts = adjustedSegments.map((segment) =>
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
  const reservationFeePerMinute = price(
    'reservationFeePerMinute',
    firstTariff?.reservationFeePerMinute ?? null,
  );
  const firstTaxRate = price('taxRate', firstTariff?.taxRate ?? null);
  const reservationHoldingFeeCents = dollarsToCents(
    reservationHoldingMinutes * reservationFeePerMinute,
  );

  // Tax is rounded once per rate: the amounts of every segment (and the
  // holding fee) at one rate are summed and taxed together, and each part
  // carries its share of that tax (taxPerRate), so the per-segment components
  // add up to the session's tax per rate.
  const segmentRates = adjustedSegments.map((segment) => price('taxRate', segment.tariff.taxRate));
  const partTaxes = taxPerRate(
    [
      ...segmentAmounts.map((b, i) => ({
        taxRate: segmentRates[i] ?? 0,
        amountCents: amountInBasis(b),
      })),
      { taxRate: firstTaxRate, amountCents: reservationHoldingFeeCents },
    ],
    basis,
  );
  const segmentBreakdowns = segmentAmounts.map((b, i) =>
    withTax(b, partTaxes[i] ?? { taxRate: segmentRates[i] ?? 0, netCents: 0, taxCents: 0 }),
  );
  const holdingTax = partTaxes[segmentAmounts.length] ?? {
    taxRate: firstTaxRate,
    netCents: 0,
    taxCents: 0,
  };
  const reservationHolding: CostTaxLine = {
    ...holdingTax,
    energyCostCents: 0,
    timeCostCents: 0,
    sessionFeeCents: 0,
    idleFeeCents: 0,
    reservationHoldingFeeCents,
  };

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

/** The amount billed, in the breakdown's basis: the sum of its dimensions. */
function amountInBasis(b: CostBreakdown): number {
  return (
    b.energyCostCents +
    b.timeCostCents +
    b.sessionFeeCents +
    b.idleFeeCents +
    b.reservationHoldingFeeCents
  );
}

/** A segment's amounts with its share of its rate's tax. */
function withTax(b: CostBreakdown, tax: TaxLine): CostBreakdown {
  const dimensions = {
    energyCostCents: b.energyCostCents,
    timeCostCents: b.timeCostCents,
    sessionFeeCents: b.sessionFeeCents,
    idleFeeCents: b.idleFeeCents,
    reservationHoldingFeeCents: b.reservationHoldingFeeCents,
  };
  return {
    basis: b.basis,
    ...dimensions,
    ...(b.billableIdleMinutes != null ? { billableIdleMinutes: b.billableIdleMinutes } : {}),
    subtotalCents: tax.netCents,
    taxCents: tax.taxCents,
    totalCents: tax.netCents + tax.taxCents,
    taxLines: taxBreakdownByRate([{ ...tax, ...dimensions }]),
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
  const idleOf = (b: CostBreakdown): { billableIdleMinutes?: number } =>
    b.billableIdleMinutes != null ? { billableIdleMinutes: b.billableIdleMinutes } : {};
  const components: CostComponentGroup[] = isSplit(breakdown)
    ? [
        ...breakdown.segments.map((seg, i) => ({
          segment: i + 1,
          taxLines: seg.taxLines,
          ...idleOf(seg),
        })),
        { segment: null, taxLines: taxBreakdownByRate([breakdown.reservationHolding]) },
      ]
    : [{ segment: null, taxLines: breakdown.taxLines, ...idleOf(breakdown) }];
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
