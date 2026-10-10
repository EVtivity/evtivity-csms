// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP 2.1 TariffType a station receives for local cost calculation
// (AuthorizeResponse.tariff, I08; ChangeTransactionTariffRequest.tariff, I11).
// It translates the tariff definitions the CSMS bills with into the OCPP
// structure and computes no amounts: the CSMS cost assembly stays the bill.

import crypto from 'node:crypto';
import { netUnitPrice, vatPercentFromFraction } from './price-display.js';
import type { TaxBasis } from './price-display.js';
import type { TariffRestrictions } from './tariff-restrictions.js';
import { getZonedComponents } from './time-window.js';
import { compareTariffs } from './tariff-resolver.js';

/** A tariff as the builder reads it (a `tariffs` row or a price snapshot). */
export interface OcppTariffSource {
  id: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
}

export type OcppDayOfWeek =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

/** TariffConditionsType: the fields the CSMS tariff restrictions map to. */
export interface OcppTariffConditions {
  startTimeOfDay?: string;
  endTimeOfDay?: string;
  dayOfWeek?: OcppDayOfWeek[];
  validFromDate?: string;
  validToDate?: string;
  minEnergy?: number;
  minIdleTime?: number;
}

/** TariffConditionsFixedType: no energy or time conditions (applied at the start). */
export type OcppTariffFixedConditions = Omit<OcppTariffConditions, 'minEnergy' | 'minIdleTime'>;

export interface OcppTaxRate {
  type: string;
  tax: number;
}

export interface OcppTariffEnergy {
  prices: Array<{ priceKwh: number; conditions?: OcppTariffConditions }>;
  taxRates?: OcppTaxRate[];
}

export interface OcppTariffTime {
  prices: Array<{ priceMinute: number; conditions?: OcppTariffConditions }>;
  taxRates?: OcppTaxRate[];
}

export interface OcppTariffFixed {
  prices: Array<{ priceFixed: number; conditions?: OcppTariffFixedConditions }>;
  taxRates?: OcppTaxRate[];
}

/** OCPP 2.1 TariffType as the CSMS sends it. validFrom is never sent (I08.FR.09). */
export interface OcppTariff {
  tariffId: string;
  currency: string;
  energy?: OcppTariffEnergy;
  chargingTime?: OcppTariffTime;
  idleTime?: OcppTariffTime;
  fixedFee?: OcppTariffFixed;
  reservationTime?: OcppTariffTime;
}

/** What the station reported in its device model (TariffCostCtrlr). */
export interface OcppTariffStationSupport {
  /**
   * TariffCostCtrlr.ConditionsSupported[Tariff]. A station without conditions
   * must report false (I chapter 1.2), so unreported counts as supported.
   */
  conditions: boolean;
  /** TariffCostCtrlr.MaxElements[Tariff]: price elements per field, null when unreported. */
  maxElements: number | null;
}

export interface OcppTariffInput {
  /** The tariff that prices the session now (the resolver's choice). */
  current: OcppTariffSource;
  /**
   * The active tariffs of the session's pricing group. With split billing the
   * CSMS moves the session to another tariff of the group when its window or
   * energy threshold starts, and the station does the same from the conditions
   * of the group's elements. Without split billing (empty) the current tariff
   * prices the whole session and is sent without restriction conditions.
   */
  groupTariffs: readonly OcppTariffSource[];
  /** `idling.gracePeriodMinutes`: the first idle minutes of a session are free of the idle fee. */
  graceMinutes: number;
  /** Pricing holidays (stored as midnight UTC dates). */
  holidays: readonly Date[];
  /** When the tariff is built: restrictions are dated from this day, in `timezone`. */
  at: Date;
  /** The site timezone (IANA): conditions are in station local time. */
  timezone: string;
  currency: string;
  taxBasis: TaxBasis;
  support: OcppTariffStationSupport;
}

const DAYS: readonly OcppDayOfWeek[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Days ahead a holiday or date range is listed: a session lasts at most about this long. */
const LOOKAHEAD_DAYS = 2;

function price(value: string | null): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A tariff price as the TariffType carries it, excluding tax (TariffEnergyPriceType
 * "excl. tax"): as entered on the 'net' basis, the tax rate taken out on the
 * 'gross' basis, in 4 decimals.
 */
function netPrice(tariff: OcppTariffSource, value: string | null, basis: TaxBasis): number {
  const amount = price(value);
  if (basis === 'net') return amount;
  return Math.round(netUnitPrice(amount, price(tariff.taxRate), basis) * 10_000) / 10_000;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** MM-DD in a year, the day clamped to the month (02-29 in a common year is 02-28). */
function dateInYear(year: number, monthDay: string): string {
  const [m, d] = monthDay.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year)}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A tariff's restrictions as TariffConditionsType entries (the tariff applies
 * under any of them). Empty means the tariff does not apply in the next
 * LOOKAHEAD_DAYS days.
 * - energyThresholdKwh: minEnergy (Wh, inclusive), as the resolver applies it
 *   once the session energy reaches the threshold.
 * - holidays: validFromDate/validToDate (end exclusive) for each holiday from
 *   today to LOOKAHEAD_DAYS ahead, in the site's local date.
 * - dateRange (MM-DD, end inclusive, wraps the year): the occurrence that has
 *   not ended and starts by LOOKAHEAD_DAYS ahead.
 * - timeRange (end exclusive): startTimeOfDay/endTimeOfDay. With daysOfWeek a
 *   window past midnight keeps calendar-day semantics, as the resolver does:
 *   "Fri 22:00-06:00" applies on Friday 00:00-06:00 and Friday 22:00-24:00, so
 *   it is sent as those two windows ("00:00" ends at midnight).
 */
export function ocppTariffConditions(
  restrictions: TariffRestrictions,
  holidays: readonly string[],
  today: string,
): OcppTariffConditions[] {
  if (restrictions.energyThresholdKwh != null) {
    return [{ minEnergy: Math.round(restrictions.energyThresholdKwh * 1000) }];
  }
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  if (restrictions.holidays === true) {
    return [...new Set(holidays)]
      .filter((day) => day >= today && day <= horizon)
      .sort()
      .map((day) => ({ validFromDate: day, validToDate: addDays(day, 1) }));
  }
  if (restrictions.dateRange != null) {
    const { startDate, endDate } = restrictions.dateRange;
    const year = Number(today.slice(0, 4));
    const result: OcppTariffConditions[] = [];
    for (const y of [year - 1, year, year + 1]) {
      const start = dateInYear(y, startDate);
      const endYear = startDate <= endDate ? y : y + 1;
      const end = addDays(dateInYear(endYear, endDate), 1);
      if (end > today && start <= horizon) result.push({ validFromDate: start, validToDate: end });
    }
    return result;
  }
  const days =
    restrictions.daysOfWeek != null
      ? [...restrictions.daysOfWeek].sort((a, b) => a - b).map((d) => DAYS[d] as OcppDayOfWeek)
      : undefined;
  const withDays = (c: OcppTariffConditions): OcppTariffConditions =>
    days != null ? { ...c, dayOfWeek: days } : c;
  const range = restrictions.timeRange;
  if (range == null) return days != null ? [{ dayOfWeek: days }] : [{}];
  const wraps = range.endTime < range.startTime && range.endTime !== '00:00';
  if (wraps && days != null) {
    return [
      withDays({ startTimeOfDay: '00:00', endTimeOfDay: range.endTime }),
      withDays({ startTimeOfDay: range.startTime, endTimeOfDay: '00:00' }),
    ];
  }
  return [withDays({ startTimeOfDay: range.startTime, endTimeOfDay: range.endTime })];
}

/**
 * The tariffs in the order the resolver tries them: restricted tariffs by
 * priority (highest first; among energy thresholds the highest threshold
 * first, as the highest threshold reached applies), then the default tariff.
 */
function resolutionOrder(tariffs: readonly OcppTariffSource[]): OcppTariffSource[] {
  // The resolver's own order (compareTariffs), so a tie between two tariffs
  // of one priority goes the same way on the station as in billing.
  const restricted = tariffs
    .filter((t) => t.restrictions != null && t.priority > 0)
    .sort(compareTariffs);
  const fallback = tariffs.find((t) => t.isDefault && t.priority === 0);
  return fallback != null ? [...restricted, fallback] : restricted;
}

interface Element {
  tariff: OcppTariffSource;
  /** Undefined: no condition (the default tariff, or a tariff sent alone). */
  conditions: OcppTariffConditions | undefined;
}

function hasConditions(c: OcppTariffConditions | undefined): c is OcppTariffConditions {
  return c != null && Object.keys(c).length > 0;
}

function withoutEnergyTime(c: OcppTariffConditions): OcppTariffFixedConditions {
  const fixed: OcppTariffFixedConditions = {};
  if (c.startTimeOfDay != null) fixed.startTimeOfDay = c.startTimeOfDay;
  if (c.endTimeOfDay != null) fixed.endTimeOfDay = c.endTimeOfDay;
  if (c.dayOfWeek != null) fixed.dayOfWeek = c.dayOfWeek;
  if (c.validFromDate != null) fixed.validFromDate = c.validFromDate;
  if (c.validToDate != null) fixed.validToDate = c.validToDate;
  return fixed;
}

function taxRatesOf(tariff: OcppTariffSource): OcppTaxRate[] | undefined {
  const rate = price(tariff.taxRate);
  // TaxRateType.tax is a percentage (19 for a stored rate of 0.19).
  return rate > 0 ? [{ type: 'VAT', tax: vatPercentFromFraction(rate) }] : undefined;
}

/**
 * The fields of a TariffType from ordered elements: the first applicable
 * element of a field is applied (I chapter 1.2), so each element lists the
 * price of every field its tariff prices, 0 included, and a window never
 * falls through to another tariff's price. A field without any price above
 * zero is left out.
 *
 * Time is billed for the whole session (charging and idle) and the idle fee
 * on top while not charging, after the first `graceMinutes` idle minutes of
 * the session: chargingTime is the time price, idleTime the time price plus
 * the idle fee from minIdleTime = the grace (inclusive), and the time price
 * before it. The reservation fee is reservationTime (I12.FR.07).
 */
function tariffFields(
  elements: readonly Element[],
  input: OcppTariffInput,
  conditionsAllowed: boolean,
): Omit<OcppTariff, 'tariffId' | 'currency'> {
  const basis = input.taxBasis;
  const graceSeconds = Math.max(0, Math.round(input.graceMinutes * 60));
  const first = elements[0];
  const taxRates = first != null ? taxRatesOf(first.tariff) : undefined;
  const tax = taxRates != null ? { taxRates } : {};
  const cond = (c: OcppTariffConditions | undefined): { conditions?: OcppTariffConditions } =>
    hasConditions(c) ? { conditions: c } : {};
  const fixedCond = (
    c: OcppTariffConditions | undefined,
  ): { conditions?: OcppTariffFixedConditions } => {
    if (!hasConditions(c)) return {};
    const fixed = withoutEnergyTime(c);
    return Object.keys(fixed).length > 0 ? { conditions: fixed } : {};
  };

  const energy = elements.map((e) => ({
    priceKwh: netPrice(e.tariff, e.tariff.pricePerKwh, basis),
    ...cond(e.conditions),
  }));
  const chargingTime = elements.map((e) => ({
    priceMinute: netPrice(e.tariff, e.tariff.pricePerMinute, basis),
    ...cond(e.conditions),
  }));
  const idleTime = elements.flatMap((e) => {
    const time = netPrice(e.tariff, e.tariff.pricePerMinute, basis);
    const idleFee = netPrice(e.tariff, e.tariff.idleFeePricePerMinute, basis);
    if (idleFee <= 0) return [{ priceMinute: time, ...cond(e.conditions) }];
    const withFee = Math.round((time + idleFee) * 10_000) / 10_000;
    if (graceSeconds === 0) return [{ priceMinute: withFee, ...cond(e.conditions) }];
    if (!conditionsAllowed) {
      // A station without conditions cannot leave the first idle minutes
      // free: the idle fee is left out (the CSMS still bills it).
      return [{ priceMinute: time }];
    }
    return [
      { priceMinute: withFee, conditions: { ...e.conditions, minIdleTime: graceSeconds } },
      { priceMinute: time, ...cond(e.conditions) },
    ];
  });
  // Applied at the start (session energy 0): an energy threshold never sets
  // the session fee or the reservation fee.
  const atStart = elements.filter((e) => e.conditions?.minEnergy == null);
  const fixedFee = atStart.map((e) => ({
    priceFixed: netPrice(e.tariff, e.tariff.pricePerSession, basis),
    ...fixedCond(e.conditions),
  }));
  const reservationTime = atStart.map((e) => ({
    priceMinute: netPrice(e.tariff, e.tariff.reservationFeePerMinute, basis),
    ...cond(e.conditions),
  }));

  const fields: Omit<OcppTariff, 'tariffId' | 'currency'> = {};
  if (energy.some((p) => p.priceKwh > 0)) fields.energy = { prices: energy, ...tax };
  if (chargingTime.some((p) => p.priceMinute > 0)) {
    fields.chargingTime = { prices: chargingTime, ...tax };
  }
  if (idleTime.some((p) => p.priceMinute > 0)) fields.idleTime = { prices: idleTime, ...tax };
  if (fixedFee.some((p) => p.priceFixed > 0)) fields.fixedFee = { prices: fixedFee, ...tax };
  if (reservationTime.some((p) => p.priceMinute > 0)) {
    fields.reservationTime = { prices: reservationTime, ...tax };
  }
  return fields;
}

function fieldSizes(fields: Omit<OcppTariff, 'tariffId' | 'currency'>): number[] {
  return [
    fields.energy?.prices.length ?? 0,
    fields.chargingTime?.prices.length ?? 0,
    fields.idleTime?.prices.length ?? 0,
    fields.fixedFee?.prices.length ?? 0,
    fields.reservationTime?.prices.length ?? 0,
  ];
}

/**
 * tariffId from the content: a TariffType with different content has a
 * different id (I08.FR.08), so the tariffIds stations report in cost details
 * stay valid after a tariff is edited.
 */
function contentTariffId(content: Omit<OcppTariff, 'tariffId'>): string {
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return `evt-${hash.slice(0, 40)}`;
}

/**
 * The TariffType for a session at the station. With the group's tariffs, the
 * station gets every tariff the CSMS can move the session to, as conditioned
 * elements in resolution order, so its local cost follows the same tariff
 * windows the CSMS splits the session at. It gets the current tariff alone
 * (no restriction conditions) when the group is not given, the station does
 * not support conditions, the tariffs have different tax rates (a field has
 * one taxRates list), the elements exceed TariffCostCtrlr.MaxElements, or the
 * current tariff is not one of the group's. The CSMS then sends a
 * ChangeTransactionTariff when it switches the session's tariff.
 */
export function buildOcppTariff(input: OcppTariffInput): OcppTariff {
  const today = getZonedComponents(input.at, input.timezone).isoDate;
  const holidays = input.holidays.map((h) => h.toISOString().slice(0, 10));
  const conditionsAllowed = input.support.conditions;
  const maxElements = input.support.maxElements;
  const fits = (fields: Omit<OcppTariff, 'tariffId' | 'currency'>): boolean =>
    maxElements == null || fieldSizes(fields).every((n) => n <= maxElements);

  let fields: Omit<OcppTariff, 'tariffId' | 'currency'> | null = null;
  const ordered = resolutionOrder(input.groupTariffs);
  const oneTaxRate = new Set(ordered.map((t) => price(t.taxRate))).size <= 1;
  if (
    conditionsAllowed &&
    ordered.length > 1 &&
    oneTaxRate &&
    ordered.some((t) => t.id === input.current.id)
  ) {
    const elements = ordered.flatMap((tariff): Element[] =>
      tariff.restrictions != null && tariff.priority > 0
        ? ocppTariffConditions(tariff.restrictions, holidays, today).map((conditions) => ({
            tariff,
            conditions,
          }))
        : [{ tariff, conditions: undefined }],
    );
    const grouped = tariffFields(elements, input, true);
    if (fits(grouped)) fields = grouped;
  }
  if (fields == null) {
    const alone = tariffFields(
      [{ tariff: input.current, conditions: undefined }],
      input,
      conditionsAllowed,
    );
    // A station that takes one price per field gets the idle price without
    // the grace element (the first idle minutes free cannot be expressed).
    fields = fits(alone)
      ? alone
      : tariffFields([{ tariff: input.current, conditions: undefined }], input, false);
  }

  const content = { currency: input.currency, ...fields };
  return { tariffId: contentTariffId(content), ...content };
}
