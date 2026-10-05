// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolveLocale } from './number.js';

/**
 * The single place for tax and price-display logic: how tariff prices are
 * entered (tax basis), whether prices shown to drivers include tax ('gross')
 * or exclude it ('net'), net, gross, and tax amounts, tax lines per rate, the
 * stored session cost breakdown, and their display. Pure and browser-safe, so
 * the portal and the CSMS import it via `@evtivity/lib/price-display`. Server
 * code (invoices, revenue, OCPI, notifications) reads stored amounts and calls
 * these functions; it does no tax math of its own.
 *
 * Rounding rules (what the driver was charged):
 * - Tax basis 'net' (default): tariff prices exclude tax. Each billed amount
 *   is quantity times price rounded to the cent. Tax is the net amount times
 *   the rate, rounded half up to the cent (taxOnNet), once per tax rate of a
 *   session: the amounts of every tariff segment (and a split session's
 *   reservation holding fee, at the first segment's rate) billed at one rate
 *   are summed first (taxPerRate).
 * - Tax basis 'gross': tariff prices include tax. Each billed amount is
 *   quantity times the gross price rounded to the cent, so a gross unit price
 *   times its quantity is exactly the amount charged. The tax contained in
 *   the gross sum of each rate is extracted once (splitGrossByTaxRate).
 * - A charged (gross) amount at one rate splits into net and tax with
 *   netFromGross, round(gross / (1 + rate)), which gives back the cost
 *   calculator's net exactly for an amount it produced on the net basis.
 * - Tax spread over several parts (cost dimensions, invoice lines, a gross
 *   shared across rates) uses allocateCents (largest remainder, ties to the
 *   earlier part), so the parts add up to the charged amount to the cent.
 */
export const TAX_BASES = ['net', 'gross'] as const;

/** How tariff prices are entered and stored: excluding ('net') or including ('gross') tax. */
export type TaxBasis = (typeof TAX_BASES)[number];

/** Used when the company setting company.taxBasis is not set. Today's behavior. */
export const DEFAULT_TAX_BASIS: TaxBasis = 'net';

export function isTaxBasis(value: unknown): value is TaxBasis {
  return typeof value === 'string' && (TAX_BASES as readonly string[]).includes(value);
}

/** A stored tax basis, or the default for a value that is not one (null on older rows). */
export function resolveTaxBasis(value: unknown): TaxBasis {
  return isTaxBasis(value) ? value : DEFAULT_TAX_BASIS;
}

export const PRICE_DISPLAYS = ['gross', 'net'] as const;

export type PriceDisplay = (typeof PRICE_DISPLAYS)[number];

/** Used when neither the driver nor the company setting company.priceDisplay is set. */
export const DEFAULT_PRICE_DISPLAY: PriceDisplay = 'net';

export function isPriceDisplay(value: unknown): value is PriceDisplay {
  return typeof value === 'string' && (PRICE_DISPLAYS as readonly string[]).includes(value);
}

/** The driver's choice, else the company setting, else the default. */
export function resolvePriceDisplay(driverValue: unknown, companyValue: unknown): PriceDisplay {
  if (isPriceDisplay(driverValue)) return driverValue;
  if (isPriceDisplay(companyValue)) return companyValue;
  return DEFAULT_PRICE_DISPLAY;
}

/**
 * A tariff unit price excluding tax. On the 'net' basis that is the stored
 * price; on the 'gross' basis the stored price includes the tax rate (a
 * decimal, 0.19), which is taken out. Not rounded: formatUnitPrice rounds
 * for display (2 to 4 fraction digits) and protocol encoders round as they
 * require.
 */
export function netUnitPrice(price: number, taxRate: number, basis: TaxBasis): number {
  return basis === 'gross' ? price / (1 + taxRate) : price;
}

/** A tariff unit price including tax: the stored price on the 'gross' basis, else with the rate added. */
export function grossUnitPrice(price: number, taxRate: number, basis: TaxBasis): number {
  return basis === 'gross' ? price : price * (1 + taxRate);
}

/**
 * A stored tariff price as shown: including tax for the 'gross' display,
 * excluding it for 'net', whichever basis the price was entered in.
 */
export function priceForDisplay(
  price: number,
  taxRate: number,
  priceDisplay: PriceDisplay,
  basis: TaxBasis,
): number {
  return priceDisplay === 'gross'
    ? grossUnitPrice(price, taxRate, basis)
    : netUnitPrice(price, taxRate, basis);
}

/**
 * A stored unit price (a numeric string, as tariffs and session snapshots
 * hold it), entered in the tax basis, as shown for the price display. Null
 * when the price is absent, not a number, or not above 0, so callers leave
 * the component out.
 */
export function unitPriceForDisplay(
  storedPrice: string | number | null | undefined,
  taxRate: string | number | null | undefined,
  priceDisplay: PriceDisplay,
  basis: TaxBasis,
): number | null {
  const price = storedPrice == null ? NaN : Number(storedPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return priceForDisplay(price, taxRateFraction(taxRate), priceDisplay, basis);
}

/** A stored tax rate (numeric string or number) as a fraction, 0 when absent or invalid. */
export function taxRateFraction(taxRate: string | number | null | undefined): number {
  const rate = taxRate == null ? NaN : Number(taxRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** The unit prices of a tariff as a driver sees them, in major units of the currency. */
export interface TariffPriceView {
  priceDisplay: PriceDisplay;
  /** Per kWh, null when the tariff has no energy price. */
  energy: number | null;
  /** Per charging minute, null when absent. */
  time: number | null;
  /** Per session, null when absent. */
  session: number | null;
  /** Per idle minute, null when absent. */
  idle: number | null;
  /** The tariff tax rate as a fraction (0.19), 0 when the tariff has none. */
  taxRate: number;
}

/**
 * A tariff's unit prices, entered in the tax basis, as shown for a price
 * display choice: with the tariff tax rate added or taken out. Zero and
 * absent prices are null. Station screens and other price summaries format
 * this view.
 */
export function tariffPriceView(
  tariff: {
    pricePerKwh: string | number | null;
    pricePerMinute: string | number | null;
    pricePerSession: string | number | null;
    idleFeePricePerMinute: string | number | null;
    taxRate: string | number | null;
  },
  priceDisplay: PriceDisplay,
  basis: TaxBasis,
): TariffPriceView {
  const show = (price: string | number | null): number | null =>
    unitPriceForDisplay(price, tariff.taxRate, priceDisplay, basis);
  return {
    priceDisplay,
    energy: show(tariff.pricePerKwh),
    time: show(tariff.pricePerMinute),
    session: show(tariff.pricePerSession),
    idle: show(tariff.idleFeePricePerMinute),
    taxRate: taxRateFraction(tariff.taxRate),
  };
}

/**
 * A tax rate fraction as a percentage number (0.19 -> 19). Rounded to 4
 * decimals, so float noise (0.19 * 100 = 19.000000000000004) does not leak
 * into protocol payloads (OCPI `vat`, 2.3.0 TaxAmount `percentage`).
 */
export function vatPercentFromFraction(taxRate: number): number {
  return Math.round(taxRate * 100 * 10_000) / 10_000;
}

/**
 * The one tax rate formatter: a rate fraction (0.19) as a percentage number in
 * the locale, with at most 2 fraction digits and no trailing zeros: "19",
 * "7.5" (en), "7,5" (de). The percent sign belongs to the localized text
 * around it ("incl. {{rate}}% tax", "{rate} %"), so each language places it.
 */
export function formatTaxRatePercent(taxRate: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(resolveLocale(locale), { maximumFractionDigits: 2 }).format(
    vatPercentFromFraction(taxRate),
  );
}

/**
 * Whether a session cost contains tax: an amount above 0 billed with a tariff
 * tax rate above 0. Labels such as "incl. tax" are shown only then.
 */
export function costIncludesTax(
  costCents: number | null | undefined,
  taxRate: string | number | null | undefined,
): boolean {
  return costCents != null && costCents > 0 && Number(taxRate ?? 0) > 0;
}

/**
 * Whether a session cost contains tax, from the tax stored with it
 * (charging_sessions.tax_cents, written with every cost): an amount above 0
 * whose stored tax is above 0. Portal lists and the guest page gate their
 * "incl. tax" labels on it, so a session whose tariffs charged no tax (or a
 * free session) never reads "incl. tax".
 */
export function costContainsTax(
  costCents: number | null | undefined,
  taxCents: number | null | undefined,
): boolean {
  return costCents != null && costCents > 0 && taxCents != null && taxCents > 0;
}

/** A session cost split into its net amount and the tax it contains. */
export interface SessionCostTax {
  netCents: number;
  /** Tax contained in the cost, in cents. Always above 0. */
  taxCents: number;
  /** The tax rate as a decimal string, or null when tariffs with different rates applied. */
  taxRate: string | null;
}

/**
 * The tax contained in a session cost, read from its stored breakdown
 * (charging_sessions.cost_breakdown, written with the cost by
 * @evtivity/database session-pricing). taxRate is the rate when all tax was
 * charged at one rate, else null. Null without a breakdown, for a cost of 0,
 * and when the cost contains no tax.
 */
export function sessionCostTax(breakdown: SessionCostBreakdown | null): SessionCostTax | null {
  if (breakdown == null || breakdown.grossCents <= 0 || breakdown.taxCents <= 0) return null;
  const taxedRates = breakdown.taxLines.filter((line) => line.taxCents !== 0);
  const onlyRate = taxedRates.length === 1 ? taxedRates[0] : undefined;
  return {
    netCents: breakdown.netCents,
    taxCents: breakdown.taxCents,
    taxRate: onlyRate != null ? String(onlyRate.taxRate) : null,
  };
}

/** Net amount and tax of one tax rate, in cents. */
export interface TaxLine {
  /** Tax rate as a fraction (0.19 is 19%). */
  taxRate: number;
  netCents: number;
  taxCents: number;
}

/** The cost dimensions of a session, in the order their tax is allocated. */
export const COST_DIMENSIONS = [
  'energyCostCents',
  'timeCostCents',
  'sessionFeeCents',
  'idleFeeCents',
  'reservationHoldingFeeCents',
] as const;

export type CostDimension = (typeof COST_DIMENSIONS)[number];

/**
 * A tax line of a cost breakdown: the amount of each cost dimension billed at
 * the rate, in the breakdown's tax basis (net amounts on the 'net' basis,
 * gross amounts on the 'gross' basis). netCents and taxCents are the net
 * amount and the tax the cost calculator charged (rounded once per rate; a
 * segment's share of its rate's tax in a split session's components). On the 'net' basis netCents is the sum of the dimensions,
 * on the 'gross' basis netCents plus taxCents is. dimensionAmounts gives each
 * dimension's net amount and tax.
 */
export type CostTaxLine = TaxLine & Record<CostDimension, number>;

/** Totals of a set of tax lines, in cents. */
export interface TaxTotals {
  netCents: number;
  taxCents: number;
  grossCents: number;
}

/** Tax of a net amount in cents at a rate, rounded half up to the cent. */
export function taxOnNet(netCents: number, taxRate: number): number {
  return Math.round(netCents * taxRate);
}

/**
 * A net amount charged with tax at one rate: the tax is taxOnNet and the gross
 * amount, what the driver pays, is net plus tax. Used for charges priced net,
 * such as reservation cancellation and no-show fees. netFromGross of the
 * gross amount gives back the net exactly.
 */
export function taxLineFromNet(netCents: number, taxRate: number): TaxBreakdownLine {
  const taxCents = taxOnNet(netCents, taxRate);
  return { taxRate, netCents, taxCents, grossCents: netCents + taxCents };
}

/**
 * Net amount contained in a gross amount (tax included) at one rate:
 * round(gross / (1 + rate)).
 *
 * For an amount the cost calculator produced from a single tariff
 * (gross = net + taxOnNet(net, rate)), this returns that net exactly, because
 * gross / (1 + rate) differs from net by less than half a cent.
 */
export function netFromGross(grossCents: number, taxRate: number): number {
  return taxRate > 0 ? Math.round(grossCents / (1 + taxRate)) : grossCents;
}

/** Split a gross amount into net and tax at one rate (tax = gross - net). */
export function splitGrossByTaxRate(grossCents: number, taxRate: number): TaxLine {
  const netCents = netFromGross(grossCents, taxRate);
  return { taxRate, netCents, taxCents: grossCents - netCents };
}

/**
 * Lines merged per tax rate: every amount of lines with the same rate is
 * summed (net, tax, and for cost lines each component), lines without any
 * amount are dropped, and the result is ordered by rate. The inputs are not
 * modified.
 */
export function taxBreakdownByRate<T extends TaxLine>(lines: readonly T[]): T[] {
  const byRate = new Map<number, T>();
  for (const line of lines) {
    if (line.netCents === 0 && line.taxCents === 0) continue;
    const existing = byRate.get(line.taxRate);
    if (existing == null) {
      byRate.set(line.taxRate, { ...line });
      continue;
    }
    const sums = existing as Record<string, unknown>;
    for (const [key, value] of Object.entries(line)) {
      if (key !== 'taxRate' && typeof value === 'number') {
        sums[key] = (sums[key] as number) + value;
      }
    }
  }
  return [...byRate.values()].sort((a, b) => a.taxRate - b.taxRate);
}

/** A per-rate breakdown line with its gross amount (net plus tax). */
export interface TaxBreakdownLine extends TaxLine {
  grossCents: number;
}

/** taxBreakdownByRate with the gross amount of each rate. */
export function taxBreakdownWithGross(lines: readonly TaxLine[]): TaxBreakdownLine[] {
  return taxBreakdownByRate(lines).map((line) => ({
    ...line,
    grossCents: line.netCents + line.taxCents,
  }));
}

/** Sum of the net amounts and taxes of a set of tax lines. */
export function taxTotals(lines: readonly TaxLine[]): TaxTotals {
  let netCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    netCents += line.netCents;
    taxCents += line.taxCents;
  }
  return { netCents, taxCents, grossCents: netCents + taxCents };
}

/**
 * Split `totalCents` into whole cents proportional to `weights` (largest
 * remainder method). The parts always sum to `totalCents`. Ties go to the
 * earlier weight. When every weight is zero, the first part takes the total.
 */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum === 0) return weights.map((_, i) => (i === 0 ? totalCents : 0));

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const parts = exact.map((x) => Math.floor(x));
  let remainder = totalCents - parts.reduce((sum, p) => sum + p, 0);
  const order = exact
    .map((x, i) => ({ i, fraction: x - Math.floor(x) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    remainder--;
  }
  return parts;
}

/**
 * Tax lines that sum exactly to `grossCents`, the amount the driver was
 * charged. Lines that already sum to it are returned as they are. Otherwise
 * (the tariff or a setting changed after the session ended) the gross amount
 * is split across the lines' rates in proportion to their gross amounts
 * (allocateCents), and each part is split into net and tax with
 * splitGrossByTaxRate. Without lines, the whole amount goes to `fallbackRate`.
 */
export function reconcileTaxLines(
  lines: TaxLine[],
  grossCents: number,
  fallbackRate: number,
): TaxLine[] {
  if (lines.length === 0) {
    return grossCents === 0 ? [] : [splitGrossByTaxRate(grossCents, fallbackRate)];
  }
  if (taxTotals(lines).grossCents === grossCents) return lines;
  const parts = allocateCents(
    grossCents,
    lines.map((l) => l.netCents + l.taxCents),
  );
  return lines.map((l, i) => splitGrossByTaxRate(parts[i] ?? 0, l.taxRate));
}

/** Gross amounts of `count` charges of the same gross amount at one tax rate. */
export interface GrossAmountGroup {
  taxRate: number;
  grossCents: number;
  count: number;
}

/**
 * Revenue excluding tax, tax, and gross revenue of many charges, each given
 * as a gross amount at a tax rate. Every charge is split on its own
 * (netFromGross), as the cost calculator taxed it, so the result is the sum
 * of the per-charge amounts. Charges of the same amount and rate are passed
 * once with their count, so a database can group them.
 */
export function revenueFromGrossGroups(groups: readonly GrossAmountGroup[]): TaxTotals {
  let netCents = 0;
  let grossCents = 0;
  for (const group of groups) {
    netCents += netFromGross(group.grossCents, group.taxRate) * group.count;
    grossCents += group.grossCents * group.count;
  }
  return { netCents, taxCents: grossCents - netCents, grossCents };
}

/**
 * The tax of a cost tax line spread over its dimensions in proportion to their
 * amounts (allocateCents, ties to the earlier dimension in COST_DIMENSIONS
 * order). The dimension amounts are in the breakdown's basis, so on the
 * 'gross' basis the tax follows the gross amounts. The dimension taxes add up
 * to exactly the line's tax. Invoice line items and OCPI dimension costs both
 * take their tax from here.
 */
export function dimensionTaxCents(line: CostTaxLine): Record<CostDimension, number> {
  const taxes = allocateCents(
    line.taxCents,
    COST_DIMENSIONS.map((d) => line[d]),
  );
  const result = {} as Record<CostDimension, number>;
  COST_DIMENSIONS.forEach((d, i) => {
    result[d] = taxes[i] ?? 0;
  });
  return result;
}

/**
 * The net amount and tax of each dimension of a cost tax line. On the 'net'
 * basis the net amount is the dimension amount; on the 'gross' basis the
 * dimension amount is the gross, so net plus tax equals it exactly (a gross
 * unit price times its quantity is the gross line). Each dimension's net and
 * tax add up to the line's net and tax.
 */
export function dimensionAmounts(
  line: CostTaxLine,
  basis: TaxBasis,
): Record<CostDimension, TaxLine> {
  const taxes = dimensionTaxCents(line);
  const result = {} as Record<CostDimension, TaxLine>;
  for (const d of COST_DIMENSIONS) {
    const taxCents = taxes[d];
    result[d] = {
      taxRate: line.taxRate,
      netCents: basis === 'gross' ? line[d] - taxCents : line[d],
      taxCents,
    };
  }
  return result;
}

/**
 * One cost dimension (energy, time, session fee, idle fee, reservation fee) of
 * a breakdown's tax lines, as a tax line per rate (dimensionAmounts). Rates
 * without the dimension are left out.
 */
export function splitDimensionByTaxLines(
  taxLines: readonly CostTaxLine[],
  dimension: CostDimension,
  basis: TaxBasis,
): TaxLine[] {
  return taxLines
    .filter((line) => line[dimension] !== 0)
    .map((line) => dimensionAmounts(line, basis)[dimension]);
}

/** The net amount and tax of an amount billed at one rate, in the tax basis it was priced in. */
export function taxLineForAmount(amountCents: number, taxRate: number, basis: TaxBasis): TaxLine {
  return basis === 'gross'
    ? splitGrossByTaxRate(amountCents, taxRate)
    : { taxRate, netCents: amountCents, taxCents: taxOnNet(amountCents, taxRate) };
}

/** An amount billed at one rate, in the tax basis it was priced in. */
export interface RatedAmount {
  taxRate: number;
  amountCents: number;
}

/**
 * The net amount and tax of each part of a cost, with tax rounded once per
 * rate: the amounts of all parts at one rate are summed and taxed together
 * (taxLineForAmount), then that tax is spread over the parts in proportion
 * to their amounts (allocateCents). One line per part, in input order. The
 * parts of a rate add up to that rate's tax exactly.
 */
export function taxPerRate(parts: readonly RatedAmount[], basis: TaxBasis): TaxLine[] {
  const indexesByRate = new Map<number, number[]>();
  parts.forEach((part, index) => {
    const indexes = indexesByRate.get(part.taxRate);
    if (indexes == null) indexesByRate.set(part.taxRate, [index]);
    else indexes.push(index);
  });
  const taxes: number[] = parts.map(() => 0);
  for (const [taxRate, indexes] of indexesByRate) {
    const amounts = indexes.map((i) => parts[i]?.amountCents ?? 0);
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    const shares = allocateCents(taxLineForAmount(total, taxRate, basis).taxCents, amounts);
    indexes.forEach((partIndex, i) => {
      taxes[partIndex] = shares[i] ?? 0;
    });
  }
  return parts.map((part, i) => {
    const taxCents = taxes[i] ?? 0;
    return {
      taxRate: part.taxRate,
      netCents: basis === 'gross' ? part.amountCents - taxCents : part.amountCents,
      taxCents,
    };
  });
}

/** Billed components of one tariff segment (1-based), or of the whole session (null). */
export interface CostComponentGroup {
  segment: number | null;
  taxLines: CostTaxLine[];
}

/**
 * The cost of a session as stored on charging_sessions.cost_breakdown, next
 * to net_cents and tax_cents, by the one cost assembly
 * (@evtivity/database session-pricing) whenever it writes current_cost_cents
 * or final_cost_cents. grossCents is that cost (the amount charged, tax
 * included). Invoices, OCPI, the portal, and reports read it and never
 * recompute a session.
 */
export interface SessionCostBreakdown {
  /** The tax basis the tariff prices were entered in when the session was priced. */
  basis: TaxBasis;
  netCents: number;
  taxCents: number;
  grossCents: number;
  /** Net amount and tax per tax rate, ordered by rate, without zero lines. They sum to the totals. */
  taxLines: TaxLine[];
  /**
   * The billed components (energy, time, fees) per tariff segment, plus the
   * reservation holding fee of a split session (segment null), when the cost
   * was calculated from the tariff. Null when only the amount charged is
   * known: costs from before itemized storage (backfilled at one rate), and
   * a charged amount that differs from the calculation.
   */
  components: CostComponentGroup[] | null;
}

/**
 * A breakdown that knows only the amount charged: the gross split at one rate
 * (splitGrossByTaxRate). Used for costs that were not calculated from the
 * tariff, such as the backfill of sessions charged before breakdowns were
 * stored.
 */
export function chargedCostBreakdown(
  grossCents: number,
  taxRate: number,
  basis: TaxBasis,
): SessionCostBreakdown {
  const line = splitGrossByTaxRate(grossCents, taxRate);
  return {
    basis,
    netCents: line.netCents,
    taxCents: line.taxCents,
    grossCents,
    taxLines: taxBreakdownByRate([line]),
    components: null,
  };
}

/**
 * A breakdown adjusted to the amount actually charged. Unchanged when it
 * already adds up to `grossCents`; otherwise its tax lines are reconciled to
 * the charged amount (reconcileTaxLines) and the components are dropped, since
 * they no longer add up to it.
 */
export function reconcileCostBreakdown(
  breakdown: SessionCostBreakdown,
  grossCents: number,
  fallbackRate: number,
): SessionCostBreakdown {
  if (breakdown.grossCents === grossCents) return breakdown;
  const taxLines = taxBreakdownByRate(
    reconcileTaxLines(breakdown.taxLines, grossCents, fallbackRate),
  );
  const totals = taxTotals(taxLines);
  return {
    basis: breakdown.basis,
    netCents: totals.netCents,
    taxCents: totals.taxCents,
    grossCents,
    taxLines,
    components: null,
  };
}

/** The component tax lines of a breakdown merged per rate, or null when it has no components. */
export function componentTaxLines(breakdown: SessionCostBreakdown): CostTaxLine[] | null {
  if (breakdown.components == null) return null;
  return taxBreakdownByRate(breakdown.components.flatMap((group) => group.taxLines));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTaxLineValue(value: unknown): value is TaxLine {
  if (value == null || typeof value !== 'object') return false;
  const line = value as Record<string, unknown>;
  return (
    isFiniteNumber(line['taxRate']) &&
    isFiniteNumber(line['netCents']) &&
    isFiniteNumber(line['taxCents'])
  );
}

function isCostTaxLineValue(value: unknown): value is CostTaxLine {
  if (!isTaxLineValue(value)) return false;
  const line = value as unknown as Record<string, unknown>;
  return COST_DIMENSIONS.every((d) => isFiniteNumber(line[d]));
}

function parseComponents(value: unknown): CostComponentGroup[] | null | undefined {
  if (value == null) return null;
  if (!Array.isArray(value)) return undefined;
  const groups: CostComponentGroup[] = [];
  for (const group of value as unknown[]) {
    if (group == null || typeof group !== 'object') return undefined;
    const g = group as Record<string, unknown>;
    const segment = g['segment'];
    const lines = g['taxLines'];
    if (segment !== null && !isFiniteNumber(segment)) return undefined;
    if (!Array.isArray(lines) || !lines.every(isCostTaxLineValue)) return undefined;
    groups.push({ segment, taxLines: lines });
  }
  return groups;
}

/**
 * A stored cost breakdown (a jsonb value) checked for shape and consistency:
 * net plus tax is the gross and the tax lines sum to the totals. Null for
 * anything else, so a reader shows the total only instead of wrong lines.
 */
export function parseSessionCostBreakdown(value: unknown): SessionCostBreakdown | null {
  if (value == null || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  const basis = b['basis'];
  const netCents = b['netCents'];
  const taxCents = b['taxCents'];
  const grossCents = b['grossCents'];
  const lines = b['taxLines'];
  if (!isTaxBasis(basis)) return null;
  if (!isFiniteNumber(netCents) || !isFiniteNumber(taxCents) || !isFiniteNumber(grossCents)) {
    return null;
  }
  if (!Array.isArray(lines) || !lines.every(isTaxLineValue)) return null;
  const totals = taxTotals(lines);
  if (
    netCents + taxCents !== grossCents ||
    totals.netCents !== netCents ||
    totals.taxCents !== taxCents
  ) {
    return null;
  }
  const components = parseComponents(b['components']);
  if (components === undefined) return null;
  return { basis, netCents, taxCents, grossCents, taxLines: lines, components };
}
