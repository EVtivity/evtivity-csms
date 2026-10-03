// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { netUnitPrice, vatPercentFromFraction } from '@evtivity/lib/price-display';
import type { TaxBasis } from '@evtivity/lib/price-display';
import type { TariffRestrictions } from '@evtivity/lib';
import type {
  OcpiDayOfWeek,
  OcpiTariff,
  OcpiTariffDimensionType,
  OcpiTariffElement,
  OcpiTariffRestrictions,
  OcpiPriceComponent,
  OcpiVersion,
} from '../types/ocpi.js';
import type { Ocpi230Tariff } from '../types/ocpi-2.3.0.js';

/** An internal tariff as the transformer reads it (a `tariffs` row). */
export interface TariffSource {
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
  isActive: boolean;
}

export interface TariffTransformInput {
  /**
   * The internal tariffs the OCPI tariff is generated from: one tariff for a
   * mapping to a tariff (published without its restrictions), or the tariffs
   * of a pricing group (published with their restrictions).
   */
  tariffs: TariffSource[];
  /** True for a pricing group: each tariff's restrictions become element restrictions. */
  applyRestrictions: boolean;
  /** Pricing holidays (YYYY-MM-DD) for tariffs restricted to holidays. */
  holidays: string[];
  /** Today (YYYY-MM-DD): past holidays and date ranges are left out. */
  today: string;
  /** The company currency: tariffs are priced in it. */
  currency: string;
  /** The company tax basis the tariff prices are entered in (company.taxBasis). */
  taxBasis: TaxBasis;
  countryCode: string;
  partyId: string;
  ocpiTariffId: string;
  lastUpdated: Date;
}

const DAYS: readonly OcpiDayOfWeek[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

/** The dimensions an element prices, in the order they are sent. */
const DIMENSIONS: readonly OcpiTariffDimensionType[] = ['ENERGY', 'TIME', 'PARKING_TIME', 'FLAT'];

function price(value: string | null): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** OCPI prices have 4 decimals. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A tariff price excluding tax, as OCPI prices are: as entered on the 'net'
 * tax basis, with the tariff tax rate taken out on the 'gross' basis.
 */
function netPrice(tariff: TariffSource, value: string | null, basis: TaxBasis): number {
  return netUnitPrice(price(value), price(tariff.taxRate), basis);
}

/**
 * The price per OCPI unit of each dimension, excluding tax. TIME and PARKING_TIME are
 * "defined in hours", so per-minute prices are multiplied by 60. The
 * calculator bills the time price for the whole session, charging or not, and
 * the idle fee on top while the EV is not charging: PARKING_TIME is the time
 * price plus the idle fee. The idle grace period has no OCPI equivalent.
 */
function dimensionPrices(
  tariff: TariffSource,
  basis: TaxBasis,
): Record<OcpiTariffDimensionType, number> {
  const perMinute = netPrice(tariff, tariff.pricePerMinute, basis);
  return {
    ENERGY: round4(netPrice(tariff, tariff.pricePerKwh, basis)),
    TIME: round4(perMinute * 60),
    PARKING_TIME: round4((perMinute + netPrice(tariff, tariff.idleFeePricePerMinute, basis)) * 60),
    FLAT: round4(netPrice(tariff, tariff.pricePerSession, basis)),
  };
}

/** The tax rate as the OCPI VAT percentage, or null without tax. */
function vatOf(tariff: TariffSource): number | null {
  const rate = price(tariff.taxRate);
  return rate > 0 ? vatPercentFromFraction(rate) : null;
}

/**
 * A price component. step_size is 1 (1 Wh, 1 second): the calculator bills the
 * exact energy and time, and the OCPI 2.2.1 and 2.3.0 notes advise step_size 1.
 */
function component(
  type: OcpiTariffDimensionType,
  amount: number,
  vat: number | null,
): OcpiPriceComponent {
  const result: OcpiPriceComponent = { type, price: amount, step_size: 1 };
  if (vat != null) result.vat = vat;
  return result;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** MM-DD in a year, with the day clamped to the month (02-29 in a common year is 02-28). */
function dateInYear(year: number, monthDay: string): string {
  const [m, d] = monthDay.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year)}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Internal restrictions as OCPI element restrictions. Several entries mean the
 * tariff applies under any of them (one element each); none means the tariff
 * no longer applies (a past date range or no upcoming holiday).
 * - timeRange and daysOfWeek: start_time, end_time (end exclusive, wraps past
 *   midnight like the resolver), day_of_week.
 * - dateRange (MM-DD, every year, end inclusive): start_date and end_date
 *   (exclusive) for the occurrences that have not ended, up to next year.
 * - holidays: one start_date/end_date day per upcoming pricing holiday.
 * - energyThresholdKwh: min_kwh.
 */
export function toOcpiRestrictions(
  restrictions: TariffRestrictions,
  holidays: readonly string[],
  today: string,
): OcpiTariffRestrictions[] {
  if (restrictions.energyThresholdKwh != null) {
    return [{ min_kwh: restrictions.energyThresholdKwh }];
  }
  if (restrictions.holidays === true) {
    return [...new Set(holidays)]
      .filter((day) => day >= today)
      .sort()
      .map((day) => ({ start_date: day, end_date: addDays(day, 1) }));
  }
  if (restrictions.dateRange != null) {
    const { startDate, endDate } = restrictions.dateRange;
    const year = Number(today.slice(0, 4));
    const result: OcpiTariffRestrictions[] = [];
    for (const y of [year - 1, year, year + 1]) {
      const start = dateInYear(y, startDate);
      const endYear = startDate <= endDate ? y : y + 1;
      const end = addDays(dateInYear(endYear, endDate), 1);
      if (end > today) result.push({ start_date: start, end_date: end });
    }
    return result;
  }
  const result: OcpiTariffRestrictions = {};
  if (restrictions.timeRange != null) {
    result.start_time = restrictions.timeRange.startTime;
    result.end_time = restrictions.timeRange.endTime;
  }
  if (restrictions.daysOfWeek != null) {
    result.day_of_week = [...restrictions.daysOfWeek]
      .sort((a, b) => a - b)
      .map((day) => DAYS[day] as OcpiDayOfWeek);
  }
  return [result];
}

/**
 * The tariffs in the order the resolver picks them: restricted tariffs by
 * priority (highest first), then the default tariff without restrictions.
 * Inactive tariffs, and tariffs the resolver never picks (no restrictions or
 * priority 0, and not the default), are left out. A single-tariff mapping
 * publishes the mapped tariff's prices without its restrictions.
 */
function orderedTariffs(
  input: TariffTransformInput,
): Array<{ tariff: TariffSource; restrictions: Array<OcpiTariffRestrictions | undefined> }> {
  if (!input.applyRestrictions) {
    return input.tariffs.map((tariff) => ({ tariff, restrictions: [undefined] }));
  }
  const active = input.tariffs.filter((t) => t.isActive);
  const restricted = active
    .filter((t) => t.restrictions != null && t.priority > 0)
    .sort((a, b) => b.priority - a.priority)
    .map((tariff) => ({
      tariff,
      restrictions: toOcpiRestrictions(
        tariff.restrictions as TariffRestrictions,
        input.holidays,
        input.today,
      ),
    }));
  const fallback = active.find((t) => t.isDefault && t.priority === 0);
  return fallback != null
    ? [...restricted, { tariff: fallback, restrictions: [undefined] }]
    : restricted;
}

/**
 * Internal tariffs as one OCPI Tariff. Prices are net (tariff prices exclude
 * tax); `vat` is the tariff tax rate as a percentage (PriceComponent.vat,
 * "Applicable VAT percentage", 19 for a stored 0.19), omitted without tax.
 * 2.3.0 also requires `tax_included` (§11.3.1): NO with tax, N/A without.
 *
 * Partners look up each dimension in the first element whose restrictions
 * match (§11.3.1). Every element therefore lists every dimension any of the
 * tariffs prices, with 0 where its tariff does not, so a restricted window
 * never falls through to another tariff's price for a dimension it leaves
 * out. A reservation fee becomes an element with a TIME component and the
 * RESERVATION restriction ("the price of the reservation time"), ahead of its
 * tariff's element.
 */
export function transformTariff(
  input: TariffTransformInput,
  version: OcpiVersion,
): OcpiTariff | Ocpi230Tariff {
  const ordered = orderedTariffs(input);
  const priced = DIMENSIONS.filter((dimension) =>
    ordered.some(({ tariff }) => dimensionPrices(tariff, input.taxBasis)[dimension] > 0),
  );
  const dimensions = priced.length > 0 ? priced : (['ENERGY'] as const);

  const elements: OcpiTariffElement[] = [];
  for (const { tariff, restrictions } of ordered) {
    const vat = vatOf(tariff);
    const prices = dimensionPrices(tariff, input.taxBasis);
    const reservationFee = round4(
      netPrice(tariff, tariff.reservationFeePerMinute, input.taxBasis) * 60,
    );
    for (const restriction of restrictions) {
      if (reservationFee > 0) {
        elements.push({
          price_components: [component('TIME', reservationFee, vat)],
          restrictions: { ...restriction, reservation: 'RESERVATION' },
        });
      }
      const element: OcpiTariffElement = {
        price_components: dimensions.map((d) => component(d, prices[d], vat)),
      };
      if (restriction != null && Object.keys(restriction).length > 0) {
        element.restrictions = restriction;
      }
      elements.push(element);
    }
  }

  // OCPI requires at least one element: a source without a tariff that
  // applies is free, as the calculator bills a session without a tariff.
  if (elements.length === 0) {
    elements.push({ price_components: [component('ENERGY', 0, null)] });
  }

  const result: OcpiTariff = {
    country_code: input.countryCode,
    party_id: input.partyId,
    id: input.ocpiTariffId,
    currency: input.currency,
    type: 'REGULAR',
    elements,
    last_updated: input.lastUpdated.toISOString(),
  };

  if (version === '2.3.0') {
    const taxed = ordered.some(({ tariff }) => vatOf(tariff) != null);
    return { ...result, tax_included: taxed ? 'NO' : 'N/A' };
  }

  return result;
}
