// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Independent pricing oracle: what a charging session must cost under the
 * published pricing rules, computed with exact rational arithmetic (BigInt) and
 * without importing any product pricing code. Unit tests compare the cost
 * calculator with it (`@evtivity/lib/testing/pricing-oracle`), and the
 * driver journey suite imports this file directly (Node strips the types),
 * so both test layers share one statement of the rules. Not part of the
 * runtime API. Self-contained on purpose: keep it free of imports.
 *
 * Rules it encodes:
 * - Each dimension is its quantity times its unit price, rounded half up to
 *   the cent: energy (kWh), charging time (minutes of the segment), session
 *   fee (first segment only), idle fee (billable idle minutes), reservation
 *   holding fee (holding minutes times the first segment's fee).
 * - Idle grace: the first N idle minutes of the session are free, whatever
 *   the segment split (owner decision 2026-10-09). The grace is consumed from
 *   the first segment forward.
 * - Tax is rounded once per tax rate over the summed amounts at that rate
 *   (the holding fee at the first segment's rate). Net basis: tax is the net
 *   times the rate, half up. Gross basis: the net is gross / (1 + rate), half
 *   up, and the tax is the rest.
 * - A rate's tax is shared over its parts (segments, then the holding fee)
 *   and a segment's tax over its dimensions (energy, time, session fee, idle
 *   fee, holding fee order) by the largest remainder, ties to the earlier.
 * - A cost ceiling (guest card hold, prepaid credit, fleet credit) caps the
 *   gross: the ceiling is shared over the rates in proportion to their gross
 *   (largest remainder) and each part is split into net and tax at its rate.
 */

/** A decimal value as given: a number (its shortest decimal form) or a decimal string. */
export type Decimal = number | string;

/** An exact fraction. Denominator always above 0. */
export interface Rational {
  num: bigint;
  den: bigint;
}

/** A quantity: a decimal value or an exact fraction (minutesFromMs). */
export type Quantity = Decimal | Rational;

export const ORACLE_DIMENSIONS = [
  'energy',
  'time',
  'sessionFee',
  'idleFee',
  'reservationHoldingFee',
] as const;

export type OracleDimension = (typeof ORACLE_DIMENSIONS)[number];

export type OracleBasis = 'net' | 'gross';

/** Tariff unit prices in major currency units and the tax rate as a fraction; absent is 0. */
export interface OracleTariff {
  pricePerKwh?: Decimal | null;
  pricePerMinute?: Decimal | null;
  pricePerSession?: Decimal | null;
  idleFeePricePerMinute?: Decimal | null;
  reservationFeePerMinute?: Decimal | null;
  taxRate?: Decimal | null;
}

/** One tariff segment of a session: its tariff and what it measured. */
export interface OracleSegmentInput {
  tariff: OracleTariff;
  durationMinutes: Quantity;
  energyWh: Quantity;
  /** Idle minutes in this segment before the grace period. */
  idleMinutes: Quantity;
}

export interface OracleSegmentsInput {
  basis: OracleBasis;
  /** The first idle minutes of the session that are free. */
  graceMinutes: Quantity;
  /** Minutes a reservation held the EVSE before the session (whole minutes, rounded up). */
  reservationHoldingMinutes?: Quantity;
  /** In start order. The first carries the session fee and the holding fee. */
  segments: readonly OracleSegmentInput[];
  /** The most that may be charged, tax included, or null for none. */
  ceilingCents?: number | null;
}

/** An amount in the tax basis with its net amount, tax, and gross, in cents. */
export interface OracleLine {
  amountCents: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export interface OracleSegmentResult extends OracleLine {
  taxRate: number;
  /** Idle minutes billed after the grace period, as an exact fraction. */
  billableIdleMinutes: Rational;
  dimensions: Record<OracleDimension, OracleLine>;
}

export interface OracleRateResult extends OracleLine {
  taxRate: number;
  /** The rate's dimensions merged over its segments and the holding fee, tax shared by amount. */
  dimensions: Record<OracleDimension, OracleLine>;
}

export interface OracleChargedRate {
  taxRate: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export interface OracleResult {
  basis: OracleBasis;
  segments: OracleSegmentResult[];
  /** The reservation holding fee, at the first segment's rate. */
  reservationHolding: OracleLine & { taxRate: number };
  /** One entry per tax rate, ordered by rate, without zero rates. */
  rates: OracleRateResult[];
  /** Each dimension summed over all rates. */
  dimensions: Record<OracleDimension, OracleLine>;
  /** The tariff price of the session before any ceiling. */
  netCents: number;
  taxCents: number;
  grossCents: number;
  /** What is charged: the tariff price, or the ceiling when the price is above it. */
  charged: {
    capped: boolean;
    netCents: number;
    taxCents: number;
    grossCents: number;
    rates: OracleChargedRate[];
  };
}

// ---------------------------------------------------------------------------
// Exact arithmetic

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError('oracle: zero denominator');
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  const d = g === 0n ? 1n : g;
  return { num: (sign * num) / d, den: (sign * den) / d };
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** A decimal string or number (its shortest round-trip form) as an exact fraction. */
export function toRational(value: Quantity): Rational {
  if (typeof value === 'object') return rational(value.num, value.den);
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`oracle: not a finite number: ${text}`);
  }
  const match = DECIMAL.exec(text);
  if (match == null || text === '' || text === '.' || text === '-' || text === '+') {
    throw new RangeError(`oracle: not a decimal: ${text}`);
  }
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  if (whole === '' && fraction === '') throw new RangeError(`oracle: not a decimal: ${text}`);
  const shift = Number(exponent) - fraction.length;
  let num = BigInt(`${sign === '-' ? '-' : ''}${whole === '' ? '0' : whole}${fraction}`);
  let den = 1n;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den = 10n ** BigInt(-shift);
  return rational(num, den);
}

/** Exact minutes of a duration in milliseconds. */
export function minutesFromMs(ms: number): Rational {
  if (!Number.isInteger(ms))
    throw new RangeError(`oracle: milliseconds must be whole: ${String(ms)}`);
  return rational(BigInt(ms), 60_000n);
}

const ZERO: Rational = { num: 0n, den: 1n };

function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

function sub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

function div(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den, a.den * b.num);
}

function cmp(a: Rational, b: Rational): number {
  const d = a.num * b.den - b.num * a.den;
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

function min(a: Rational, b: Rational): Rational {
  return cmp(a, b) <= 0 ? a : b;
}

function floorDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  return num % den !== 0n && num < 0n !== den < 0n ? q - 1n : q;
}

/** A fraction rounded half up (ties toward plus infinity) to a whole number. */
export function roundHalfUp(value: Rational): number {
  return Number(floorDiv(2n * value.num + value.den, 2n * value.den));
}

function cents(n: number): Rational {
  return { num: BigInt(n), den: 1n };
}

function nonNegative(field: string, value: Rational): Rational {
  if (value.num < 0n) throw new RangeError(`oracle: ${field} is negative`);
  return value;
}

function priceOf(value: Decimal | null | undefined, field: string): Rational {
  if (value == null) return ZERO;
  return nonNegative(field, toRational(value));
}

function rateNumber(rate: Rational): number {
  return Number(rate.num) / Number(rate.den);
}

// ---------------------------------------------------------------------------
// Tax

/** Tax on a net amount at a rate: net times rate, half up. */
export function exactTaxOnNet(netCents: number, taxRate: Decimal): number {
  return roundHalfUp(mul(cents(netCents), toRational(taxRate)));
}

/** Net amount in a gross amount at a rate: gross / (1 + rate), half up. */
export function exactNetFromGross(grossCents: number, taxRate: Decimal): number {
  const rate = toRational(taxRate);
  if (rate.num <= 0n) return grossCents;
  return roundHalfUp(div(cents(grossCents), add({ num: 1n, den: 1n }, rate)));
}

function taxOfAmount(amountCents: number, rate: Rational, basis: OracleBasis): number {
  if (rate.num === 0n) return 0;
  if (basis === 'net') return roundHalfUp(mul(cents(amountCents), rate));
  const net = roundHalfUp(div(cents(amountCents), add({ num: 1n, den: 1n }, rate)));
  return amountCents - net;
}

/**
 * Whole cents of `total` shared in proportion to integer weights: floors
 * first, then one cent each by largest remainder, ties to the earlier. All
 * zero weights give the first part the total.
 */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  let w = weights.map((x) => {
    if (!Number.isInteger(x)) throw new RangeError(`oracle: weight must be whole: ${String(x)}`);
    return BigInt(x);
  });
  let sum = w.reduce((s, x) => s + x, 0n);
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  if (sum < 0n) {
    w = w.map((x) => -x);
    sum = -sum;
  }
  const t = BigInt(total);
  const shares = w.map((x, i) => {
    const floor = floorDiv(t * x, sum);
    return { i, floor, rem: t * x - floor * sum };
  });
  let left = t - shares.reduce((s, x) => s + x.floor, 0n);
  const out = shares.map((s) => s.floor);
  const order = [...shares].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const s of order) {
    if (left <= 0n) break;
    out[s.i] = (out[s.i] ?? 0n) + 1n;
    left -= 1n;
  }
  return out.map(Number);
}

function line(amountCents: number, taxCents: number, basis: OracleBasis): OracleLine {
  const netCents = basis === 'net' ? amountCents : amountCents - taxCents;
  return { amountCents, netCents, taxCents, grossCents: netCents + taxCents };
}

function dimensionLines(
  amounts: Record<OracleDimension, number>,
  taxCents: number,
  basis: OracleBasis,
): Record<OracleDimension, OracleLine> {
  const taxes = largestRemainder(
    taxCents,
    ORACLE_DIMENSIONS.map((d) => amounts[d]),
  );
  const out = {} as Record<OracleDimension, OracleLine>;
  ORACLE_DIMENSIONS.forEach((d, i) => {
    out[d] = line(amounts[d], taxes[i] ?? 0, basis);
  });
  return out;
}

function zeroAmounts(): Record<OracleDimension, number> {
  return { energy: 0, time: 0, sessionFee: 0, idleFee: 0, reservationHoldingFee: 0 };
}

// ---------------------------------------------------------------------------
// Pricing

/** The cost of a session from its tariff segments (one segment when split billing is off). */
export function priceSegments(input: OracleSegmentsInput): OracleResult {
  const { basis } = input;
  const grace = nonNegative('graceMinutes', toRational(input.graceMinutes));
  const holdingMinutes = nonNegative(
    'reservationHoldingMinutes',
    toRational(input.reservationHoldingMinutes ?? 0),
  );
  const hundred = cents(100);

  let graceLeft = grace;
  const parts = input.segments.map((seg, index) => {
    const t = seg.tariff;
    const minutes = nonNegative(
      `segments[${String(index)}].durationMinutes`,
      toRational(seg.durationMinutes),
    );
    const wh = nonNegative(`segments[${String(index)}].energyWh`, toRational(seg.energyWh));
    const idle = nonNegative(`segments[${String(index)}].idleMinutes`, toRational(seg.idleMinutes));
    const free = min(idle, graceLeft);
    graceLeft = sub(graceLeft, free);
    const billableIdle = sub(idle, free);
    const amounts = zeroAmounts();
    // Energy: Wh / 1000 kWh * price * 100 cents.
    amounts.energy = roundHalfUp(
      mul(mul(wh, priceOf(t.pricePerKwh, 'pricePerKwh')), { num: 1n, den: 10n }),
    );
    amounts.time = roundHalfUp(
      mul(mul(minutes, priceOf(t.pricePerMinute, 'pricePerMinute')), hundred),
    );
    amounts.sessionFee =
      index === 0 ? roundHalfUp(mul(priceOf(t.pricePerSession, 'pricePerSession'), hundred)) : 0;
    amounts.idleFee = roundHalfUp(
      mul(mul(billableIdle, priceOf(t.idleFeePricePerMinute, 'idleFeePricePerMinute')), hundred),
    );
    return { rate: priceOf(t.taxRate, 'taxRate'), amounts, billableIdle };
  });

  const first = input.segments[0]?.tariff;
  const holdingRate = priceOf(first?.taxRate, 'taxRate');
  const holdingAmount =
    first == null
      ? 0
      : roundHalfUp(
          mul(
            mul(holdingMinutes, priceOf(first.reservationFeePerMinute, 'reservationFeePerMinute')),
            hundred,
          ),
        );

  // Parts in tax order: the segments, then the holding fee.
  const taxed = [
    ...parts.map((p) => ({
      rate: p.rate,
      amount: ORACLE_DIMENSIONS.reduce((s, d) => s + p.amounts[d], 0),
    })),
    { rate: holdingRate, amount: holdingAmount },
  ];
  const partTax = taxed.map(() => 0);
  const byRate = new Map<string, { rate: Rational; indexes: number[] }>();
  taxed.forEach((p, i) => {
    const key = `${String(p.rate.num)}/${String(p.rate.den)}`;
    const entry = byRate.get(key) ?? { rate: p.rate, indexes: [] };
    entry.indexes.push(i);
    byRate.set(key, entry);
  });
  for (const { rate, indexes } of byRate.values()) {
    const amounts = indexes.map((i) => taxed[i]?.amount ?? 0);
    const total = amounts.reduce((s, a) => s + a, 0);
    const shares = largestRemainder(taxOfAmount(total, rate, basis), amounts);
    indexes.forEach((partIndex, k) => {
      partTax[partIndex] = shares[k] ?? 0;
    });
  }

  const segments: OracleSegmentResult[] = parts.map((p, i) => {
    const amount = taxed[i]?.amount ?? 0;
    const tax = partTax[i] ?? 0;
    return {
      ...line(amount, tax, basis),
      taxRate: rateNumber(p.rate),
      billableIdleMinutes: p.billableIdle,
      dimensions: dimensionLines(p.amounts, tax, basis),
    };
  });
  const holdingTax = partTax[parts.length] ?? 0;
  const reservationHolding = {
    ...line(holdingAmount, holdingTax, basis),
    taxRate: rateNumber(holdingRate),
  };

  // Per rate: dimensions merged over the rate's parts, the rate's tax shared by amount.
  const rates: OracleRateResult[] = [];
  for (const { rate, indexes } of byRate.values()) {
    const amounts = zeroAmounts();
    let tax = 0;
    for (const i of indexes) {
      tax += partTax[i] ?? 0;
      if (i < parts.length) {
        const p = parts[i];
        if (p != null) for (const d of ORACLE_DIMENSIONS) amounts[d] += p.amounts[d];
      } else {
        amounts.reservationHoldingFee += holdingAmount;
      }
    }
    const amount = ORACLE_DIMENSIONS.reduce((s, d) => s + amounts[d], 0);
    if (amount === 0 && tax === 0) continue;
    rates.push({
      ...line(amount, tax, basis),
      taxRate: rateNumber(rate),
      dimensions: dimensionLines(amounts, tax, basis),
    });
  }
  rates.sort((a, b) => a.taxRate - b.taxRate);

  const dimensions = {} as Record<OracleDimension, OracleLine>;
  for (const d of ORACLE_DIMENSIONS) {
    dimensions[d] = rates.reduce(
      (acc, r) => ({
        amountCents: acc.amountCents + r.dimensions[d].amountCents,
        netCents: acc.netCents + r.dimensions[d].netCents,
        taxCents: acc.taxCents + r.dimensions[d].taxCents,
        grossCents: acc.grossCents + r.dimensions[d].grossCents,
      }),
      { amountCents: 0, netCents: 0, taxCents: 0, grossCents: 0 },
    );
  }
  const netCents = rates.reduce((s, r) => s + r.netCents, 0);
  const taxCents = rates.reduce((s, r) => s + r.taxCents, 0);
  const grossCents = netCents + taxCents;

  const ceiling = input.ceilingCents;
  const uncappedRates = rates.map((r) => ({
    taxRate: r.taxRate,
    netCents: r.netCents,
    taxCents: r.taxCents,
    grossCents: r.grossCents,
  }));
  let charged: OracleResult['charged'] = {
    capped: false,
    netCents,
    taxCents,
    grossCents,
    rates: uncappedRates,
  };
  if (ceiling != null && grossCents > ceiling) {
    const cap = Math.max(0, ceiling);
    const shares = largestRemainder(
      cap,
      rates.map((r) => r.grossCents),
    );
    const cappedRates = rates
      .map((r, i) => {
        const gross = shares[i] ?? 0;
        const net = exactNetFromGross(gross, r.taxRate);
        return { taxRate: r.taxRate, netCents: net, taxCents: gross - net, grossCents: gross };
      })
      .filter((r) => r.grossCents !== 0);
    charged = {
      capped: true,
      netCents: cappedRates.reduce((s, r) => s + r.netCents, 0),
      taxCents: cappedRates.reduce((s, r) => s + r.taxCents, 0),
      grossCents: cap,
      rates: cappedRates,
    };
  }

  return {
    basis,
    segments,
    reservationHolding,
    rates,
    dimensions,
    netCents,
    taxCents,
    grossCents,
    charged,
  };
}

// ---------------------------------------------------------------------------
// Timeline

/** A tariff in effect from a moment (ms since epoch) until the next entry. */
export interface OracleTariffPeriod {
  from: number;
  tariff: OracleTariff;
}

/** A cumulative energy reading of the session (Wh delivered since start) at a moment. */
export interface OracleMeterReading {
  at: number;
  wh: Decimal;
}

/** An idle period (SuspendedEV) of the session, in ms since epoch. */
export interface OracleIdlePeriod {
  from: number;
  to: number;
}

export interface OracleTimelineInput {
  basis: OracleBasis;
  graceMinutes: Quantity;
  /** Split billing on: a tariff change during the session opens a segment. Off: the start tariff prices the whole session. */
  splitBilling: boolean;
  startedAt: number;
  /** The session end, or the moment of a running cost. */
  endedAt: number;
  /** Tariffs in effect, in time order. The entry in effect at startedAt is the session tariff. */
  tariffs: readonly OracleTariffPeriod[];
  meter: readonly OracleMeterReading[];
  idle?: readonly OracleIdlePeriod[];
  /** Reservation start before the session: the holding fee runs from it to startedAt, in whole minutes rounded up. */
  reservationStartedAt?: number | null;
  ceilingCents?: number | null;
}

function tariffAt(tariffs: readonly OracleTariffPeriod[], t: number): OracleTariff {
  let current: OracleTariff | undefined;
  for (const p of tariffs) if (p.from <= t) current = p.tariff;
  if (current == null) throw new RangeError('oracle: no tariff in effect at the session start');
  return current;
}

/** Energy delivered at t: the latest reading at or before t, 0 before the first. */
function energyAt(meter: readonly OracleMeterReading[], t: number): Rational {
  let latest: OracleMeterReading | undefined;
  for (const r of meter) if (r.at <= t && (latest == null || r.at >= latest.at)) latest = r;
  return latest == null ? ZERO : toRational(latest.wh);
}

function idleBetween(idle: readonly OracleIdlePeriod[], from: number, to: number): Rational {
  let ms = 0;
  for (const p of idle) ms += Math.max(0, Math.min(p.to, to) - Math.max(p.from, from));
  return minutesFromMs(ms);
}

/** The segments a timeline produces (split at each tariff change inside the session). */
export function timelineSegments(input: OracleTimelineInput): OracleSegmentInput[] {
  const { startedAt, endedAt } = input;
  if (endedAt < startedAt) throw new RangeError('oracle: session ends before it starts');
  const idle = input.idle ?? [];
  const bounds = [startedAt];
  if (input.splitBilling) {
    for (const p of input.tariffs) if (p.from > startedAt && p.from < endedAt) bounds.push(p.from);
  }
  bounds.push(endedAt);
  const segments: OracleSegmentInput[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i] as number;
    const to = bounds[i + 1] as number;
    const last = i + 2 === bounds.length;
    segments.push({
      tariff: tariffAt(input.tariffs, from),
      durationMinutes: minutesFromMs(to - from),
      energyWh: sub(energyAt(input.meter, last ? endedAt : to), energyAt(input.meter, from)),
      idleMinutes: idleBetween(idle, from, to),
    });
  }
  return segments;
}

/** The cost of a session from its timeline: tariff periods, meter readings, idle periods, reservation. */
export function priceTimeline(input: OracleTimelineInput): OracleResult {
  const holdingMs =
    input.reservationStartedAt != null
      ? Math.max(0, input.startedAt - input.reservationStartedAt)
      : 0;
  return priceSegments({
    basis: input.basis,
    graceMinutes: input.graceMinutes,
    reservationHoldingMinutes: Math.ceil(holdingMs / 60_000),
    segments: timelineSegments(input),
    ceilingCents: input.ceilingCents ?? null,
  });
}
