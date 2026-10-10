// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The pricing engine: the one place that turns tariffs, quantities, and tax
 * rates into money (owner decision 2026-10-09). Every amount the system
 * charges or shows comes from these entry points or from a breakdown they
 * produced; tax, cent rounding, and price times quantity happen only here and
 * in the two modules it is built on (cost-calculator.ts for the dimension
 * amounts, price-display.ts for tax and shares). A guard test
 * (__tests__/pricing-engine-guard.test.ts) fails when money math appears in
 * any other source file. Pure and browser-safe (`@evtivity/lib/pricing-engine`).
 *
 * Entry points:
 * - priceSessionCost: a session at a moment (running cost, final cost,
 *   TransactionEventResponse totalCost, rebill). Input: the session tariff
 *   snapshot, its segments, energy, idle minutes, grace, reservation holding
 *   minutes, tax basis, and cost ceiling. Output: per segment and per
 *   dimension the net, tax, and gross, the per-rate lines, the totals, and the
 *   stored breakdown (charging_sessions.cost_breakdown).
 * - pricedSessionFromBreakdown: the same view of a stored breakdown, for
 *   readers (invoices, OCPI, portal, receipts) that never recompute.
 * - sessionCostDimensions: per dimension, one line per tax rate, from a
 *   stored breakdown (OCPI CDR dimensions, invoice lines).
 * - dimensionGrossCents: per dimension, the gross over all rates of a priced
 *   session (receipt lines that add up to the total).
 * - priceFee / priceTimedFee: a fee outside a session's tariff segments
 *   (reservation cancellation and no-show fees, holding fees), in the tax
 *   basis it was entered in.
 * - chargeSplit: a charged gross amount split into net and tax at one rate.
 * - centsFromMajorUnits: an amount typed or received in major units (12.34)
 *   as whole cents, exact and half up.
 * - multiplyCents: an amount times an exact factor (a percentage fee).
 * - aiUsageCostMicros: the provider cost of AI model usage, in micro-USD,
 *   from token counts and the model registry's per-million-token prices.
 * - aiCostInCompanyCurrencyMicros: that cost as shown to users, in micro-units
 *   of the company currency, or null when it cannot be stated in it.
 */

import {
  calculateSessionCost,
  calculateSessionCostAt,
  toSessionCostBreakdown,
} from './cost-calculator.js';
import type { SessionPricingInput } from './cost-calculator.js';
import {
  COST_DIMENSIONS,
  allocateCents,
  capCostBreakdown,
  componentTaxLines,
  dimensionAmounts,
  multiplyCents,
  splitDimensionByTaxLines,
  splitGrossByTaxRate,
  taxBreakdownByRate,
  taxLineForAmount,
  taxRateFraction,
} from './price-display.js';
import type { CostDimension, SessionCostBreakdown, TaxBasis, TaxLine } from './price-display.js';

export { multiplyCents };
export type { CostDimension };

/** An amount at one tax rate with its net amount, tax, and gross (what is charged), in cents. */
export interface PricedAmount {
  /** Tax rate as a fraction (0.19). */
  taxRate: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

/** One tariff segment of a session (1-based), or the session-level holding fee (segment null). */
export interface PricedSegment {
  segment: number | null;
  /** Idle minutes billed in the segment after the grace period, when it has an idle fee. */
  billableIdleMinutes?: number;
  /** Each dimension of the segment at the segment's rate. Dimensions it does not bill are zero. */
  dimensions: Record<CostDimension, PricedAmount>;
  total: PricedAmount;
}

/** A priced session: what it costs, per segment, per dimension, and per tax rate. */
export interface PricedSession {
  basis: TaxBasis;
  /**
   * Per segment, in segment order, with the holding fee of a split session as
   * segment null. Empty when only the charged amount is known (a capped or
   * reconciled cost, or a cost stored before itemization).
   */
  segments: PricedSegment[];
  /**
   * Per dimension, one line per tax rate (ordered by rate, lines without the
   * dimension left out). Null when only the charged amount is known.
   */
  dimensions: Record<CostDimension, PricedAmount[]> | null;
  /** Per tax rate, ordered by rate, without zero lines. They sum to the totals. */
  taxLines: PricedAmount[];
  netCents: number;
  taxCents: number;
  /** The amount charged, tax included (at most the ceiling). */
  grossCents: number;
  /** The tariff price, tax included, when the ceiling capped it. */
  pricedGrossCents?: number;
  /** The stored form (charging_sessions.cost_breakdown). */
  breakdown: SessionCostBreakdown;
}

/** Everything a session is priced from, plus the ceiling on what it may be charged. */
export interface SessionCostInput extends SessionPricingInput {
  /** A guest card hold, prepaid credit, or fleet credit; null or absent for none. */
  ceilingCents?: number | null;
}

function priced(line: TaxLine): PricedAmount {
  return {
    taxRate: line.taxRate,
    netCents: line.netCents,
    taxCents: line.taxCents,
    grossCents: line.netCents + line.taxCents,
  };
}

function zero(taxRate: number): PricedAmount {
  return { taxRate, netCents: 0, taxCents: 0, grossCents: 0 };
}

/**
 * The cost of a session at a moment: the one assembly of segments, idle
 * grace (the first idle minutes of the session are free), reservation
 * holding fee, tax per rate, and cost ceiling.
 */
export function priceSessionCost(input: SessionCostInput): PricedSession {
  const breakdown = capCostBreakdown(
    toSessionCostBreakdown(calculateSessionCostAt(input)),
    input.ceilingCents ?? null,
    taxRateFraction(input.tariff.taxRate),
  );
  return pricedSessionFromBreakdown(breakdown);
}

/** The priced view of a stored breakdown. Never recomputes the amounts. */
export function pricedSessionFromBreakdown(breakdown: SessionCostBreakdown): PricedSession {
  const segments: PricedSegment[] = (breakdown.components ?? []).map((group) => {
    const line = group.taxLines[0];
    const rate = line?.taxRate ?? 0;
    const dims = line != null ? dimensionAmounts(line, breakdown.basis) : null;
    const dimensions = {} as Record<CostDimension, PricedAmount>;
    for (const d of COST_DIMENSIONS) dimensions[d] = dims != null ? priced(dims[d]) : zero(rate);
    return {
      segment: group.segment,
      ...(group.billableIdleMinutes != null
        ? { billableIdleMinutes: group.billableIdleMinutes }
        : {}),
      dimensions,
      total: line != null ? priced(line) : zero(rate),
    };
  });
  return {
    basis: breakdown.basis,
    segments,
    dimensions: sessionCostDimensions(breakdown),
    taxLines: breakdown.taxLines.map(priced),
    netCents: breakdown.netCents,
    taxCents: breakdown.taxCents,
    grossCents: breakdown.grossCents,
    ...(breakdown.pricedGrossCents != null ? { pricedGrossCents: breakdown.pricedGrossCents } : {}),
    breakdown,
  };
}

/**
 * Each dimension of a stored breakdown, one line per tax rate (the rate's
 * tax shared over its dimensions by amount, so they add up to the rate's tax).
 * Null when the breakdown has no components (only the charged amount is known).
 */
export function sessionCostDimensions(
  breakdown: SessionCostBreakdown,
): Record<CostDimension, PricedAmount[]> | null {
  const lines = componentTaxLines(breakdown);
  if (lines == null) return null;
  const out = {} as Record<CostDimension, PricedAmount[]>;
  for (const d of COST_DIMENSIONS) {
    out[d] = splitDimensionByTaxLines(lines, d, breakdown.basis).map(priced);
  }
  return out;
}

/**
 * Per dimension, what a priced session charged for it over all tax rates
 * (gross, tax included, in cents), so receipt lines add up to the total.
 * Null when only the charged amount is known.
 */
export function dimensionGrossCents(session: PricedSession): Record<CostDimension, number> | null {
  if (session.dimensions == null) return null;
  const out = {} as Record<CostDimension, number>;
  for (const d of COST_DIMENSIONS) {
    out[d] = session.dimensions[d].reduce((sum, line) => sum + line.grossCents, 0);
  }
  return out;
}

/** A fee amount entered in the tax basis (a no-show or cancellation fee), with its tax. */
export function priceFee(input: {
  amountCents: number;
  taxRate: string | number | null;
  basis: TaxBasis;
}): PricedAmount {
  if (!Number.isInteger(input.amountCents)) {
    throw new RangeError(`Fee amount must be whole cents, got ${String(input.amountCents)}`);
  }
  return priced(taxLineForAmount(input.amountCents, taxRateFraction(input.taxRate), input.basis));
}

/**
 * A per-minute fee (a reservation holding fee) for whole or fractional
 * minutes: the minutes times the price, half up to the cent, with its tax.
 */
export function priceTimedFee(input: {
  pricePerMinute: string | number | null;
  minutes: number;
  taxRate: string | number | null;
  basis: TaxBasis;
}): PricedAmount {
  const price = input.pricePerMinute == null ? 0 : Number(input.pricePerMinute);
  if (
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isFinite(input.minutes) ||
    input.minutes < 0
  ) {
    throw new RangeError(
      `Timed fee needs a price and minutes at or above 0, got ${String(input.pricePerMinute)} and ${String(input.minutes)}`,
    );
  }
  return priceFee({
    // minutes * price / 0.01: exact on the decimal values, in cents.
    amountCents: multiplyCents(input.minutes, price, 0.01),
    taxRate: input.taxRate,
    basis: input.basis,
  });
}

/** A charged gross amount at one rate split into net and tax. */
export function chargeSplit(grossCents: number, taxRate: string | number | null): PricedAmount {
  return priced(splitGrossByTaxRate(grossCents, taxRateFraction(taxRate)));
}

/** An amount in major units (12.34, "12.34") as whole cents, exact and half up. */
export function centsFromMajorUnits(amount: string | number): number {
  const value = typeof amount === 'string' && amount.trim() !== '' ? Number(amount.trim()) : amount;
  if (typeof value !== 'number') throw new RangeError('Not an amount: empty');
  if (!Number.isFinite(value)) throw new RangeError(`Not an amount: ${String(amount)}`);
  return multiplyCents(value, 100);
}

/**
 * Energy (Wh) at a price per kWh, as cents with the calculator's energy rule
 * (quantity times price, half up to the cent). For costs outside a session's
 * tariff, such as the wholesale electricity cost of a session.
 */
export function priceEnergyCents(energyWh: number, pricePerKwh: string | null): number {
  return calculateSessionCost(
    {
      pricePerKwh,
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: null,
    },
    energyWh,
    0,
  ).energyCostCents;
}

/** Charging and idle minutes of a component of a stored breakdown (its segment, or null for the session). */
export interface ComponentTime {
  /** The breakdown component: a tariff segment (1-based), or null for a session priced from one tariff. */
  segment: number | null;
  chargingMinutes: number;
  idleMinutes: number;
}

/**
 * Each dimension of a stored breakdown as roaming (OCPI) reports time: the
 * time price is billed for the whole session, so the component's time cost is
 * shared by its charging and idle minutes (allocateCents, exact). The
 * charging share stays in timeCostCents ("time charging", OCPI TIME); the idle
 * share moves to idleFeeCents, which then holds the cost of the time not
 * charging: the time price while idle plus the idle fee after the grace (OCPI
 * PARKING_TIME). Totals per rate are unchanged. A component without its
 * minutes keeps its split. Null when the breakdown has no components.
 */
export function sessionCostDimensionsByCharging(
  breakdown: SessionCostBreakdown,
  times: readonly ComponentTime[],
): Record<CostDimension, PricedAmount[]> | null {
  if (breakdown.components == null) return null;
  const lines = taxBreakdownByRate(
    breakdown.components.flatMap((group) => {
      const time = times.find((t) => t.segment === group.segment);
      if (time == null) return group.taxLines;
      const weights = [Math.max(0, time.chargingMinutes), Math.max(0, time.idleMinutes)];
      return group.taxLines.map((line) => {
        const [charging = line.timeCostCents, idle = 0] = allocateCents(
          line.timeCostCents,
          weights,
        );
        return { ...line, timeCostCents: charging, idleFeeCents: line.idleFeeCents + idle };
      });
    }),
  );
  const out = {} as Record<CostDimension, PricedAmount[]>;
  for (const d of COST_DIMENSIONS) {
    out[d] = splitDimensionByTaxLines(lines, d, breakdown.basis).map(priced);
  }
  return out;
}

/** Token usage of one AI model call (or a sum of calls). */
export interface AiTokenUsage {
  /** Every input token, cached reads and cache writes included. */
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  /** Every output token, reasoning included. */
  outputTokens: number;
}

/** AI model prices in micro-USD per million tokens. */
export interface AiTokenPrices {
  inputPerMTok: number;
  /** Null: cached reads bill at the input price. */
  cachedInputPerMTok: number | null;
  outputPerMTok: number;
}

const TOKENS_PER_MTOK = 1_000_000n;

/**
 * Provider cost of AI usage in micro-USD (provider prices are in USD, not the
 * company currency), rounded half up. Cache reads bill at the cached price,
 * every other input token (cache writes included) at the input price.
 * Integer math throughout, so no float rounding on large counts.
 */
export function aiUsageCostMicros(usage: AiTokenUsage, prices: AiTokenPrices): number {
  const tokens = (n: number): bigint => BigInt(Math.max(0, Math.trunc(n)));
  const cached = tokens(Math.min(usage.cachedReadTokens, usage.inputTokens));
  const uncached = tokens(usage.inputTokens) - cached;
  const cachedPrice = BigInt(prices.cachedInputPerMTok ?? prices.inputPerMTok);
  const scaled =
    uncached * BigInt(prices.inputPerMTok) +
    cached * cachedPrice +
    tokens(usage.outputTokens) * BigInt(prices.outputPerMTok);
  return Number((scaled + TOKENS_PER_MTOK / 2n) / TOKENS_PER_MTOK);
}

/** The currency AI providers price tokens in. */
export const AI_PRICE_CURRENCY = 'USD';

/**
 * An AI provider cost (micro-USD, from `aiUsageCostMicros`) in micro-units
 * of the company currency, as the usage footer and the conversation API show
 * it. No exchange rate is kept, so a company currency other than USD gives
 * null: the client then shows tokens only. Null in, null out.
 */
export function aiCostInCompanyCurrencyMicros(
  costMicrosUsd: number | null,
  companyCurrency: string,
): number | null {
  if (costMicrosUsd === null) return null;
  return companyCurrency.trim().toUpperCase() === AI_PRICE_CURRENCY ? costMicrosUsd : null;
}
