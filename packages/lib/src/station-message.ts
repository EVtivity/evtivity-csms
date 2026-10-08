// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Intl.DurationFormat (formatStationElapsed) ships in Node 24 but not in the ES2022 lib.
/// <reference lib="es2025.intl" />

import Handlebars from 'handlebars';
import {
  formatFlatPrice,
  formatTariffSummary,
  formatUnitPrice,
  formatUnitPriceWithLabel,
} from './currency.js';
import { formatNumber, resolveLocale } from './number.js';
import {
  formatTaxRatePercent,
  tariffPriceView,
  unitPriceForDisplay,
  type PriceDisplay,
  type TaxBasis,
} from './price-display.js';
import {
  DEFAULT_STATION_MESSAGE_LANGUAGE,
  STATION_PER_MINUTE_LABELS,
  STATION_PRICE_SUMMARY_LABELS,
  isStationMessageLanguage,
  type StationMessageLanguage,
} from './station-message-defaults.js';

export type StationMessageState =
  // State-bound slots (9000-9005) shown by the station based on its current
  // MessageState. Pushed by the connector-status / transaction-event listeners.
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'charging'
  | 'suspended'
  | 'discharging'
  | 'faulted'
  | 'unavailable'
  // Event-bound one-shot messages (slot 9010) dispatched on demand by
  // server-side flows (e.g. payment gate stopping a session). Not bound to a
  // MessageState, render via dispatchOneShotStationMessage and auto-clear
  // after a short TTL.
  | 'payment_failed'
  | 'payment_required'
  | 'guest_unauthorized'
  | 'unauthorized'
  | 'prepaid_exhausted'
  | 'account_credit_limit';

export interface StationMessageContext {
  companyName: string;
  /** The `stationMessage.brandLine` setting. Empty or absent renders `companyName`. */
  brandLine?: string;
  stationOcppId: string;
  pricingDisplay?: string;
  /** Single unit prices as shown (net or gross per company.priceDisplay), without units. */
  energyPrice?: string;
  timePrice?: string;
  sessionFee?: string;
  idleFee?: string;
  /** Tax rate of the shown prices in the display language ("19", "7,5"). Empty without tax. */
  taxRatePercent?: string;
  /** True when the shown prices include the tax (company.priceDisplay = gross). */
  pricesIncludeTax?: boolean;
  energyKwh?: string;
  powerKw?: string;
  costFormatted?: string;
  elapsedFormatted?: string;
  idleFeeRate?: string;
  supportPhone?: string;
  driverFirstName?: string;
  reservationExpiresAt?: string;
}

/** The price variables of a station message, in the display language. */
export type StationPriceContext = Required<
  Pick<
    StationMessageContext,
    | 'pricingDisplay'
    | 'energyPrice'
    | 'timePrice'
    | 'sessionFee'
    | 'idleFee'
    | 'taxRatePercent'
    | 'pricesIncludeTax'
  >
>;

/**
 * The tax note variables for prices shown with a tax rate: `taxRatePercent`
 * is empty when there is no tax, `pricesIncludeTax` follows the display.
 */
export function stationTaxNoteContext(
  taxRate: number,
  priceDisplay: PriceDisplay,
  language: StationMessageLanguage,
): Pick<StationPriceContext, 'taxRatePercent' | 'pricesIncludeTax'> {
  const hasTax = taxRate > 0;
  return {
    taxRatePercent: hasTax ? formatTaxRatePercent(taxRate, language) : '',
    pricesIncludeTax: hasTax && priceDisplay === 'gross',
  };
}

/**
 * Price variables for the Available screen: the tariff's prices as the
 * company shows them (company.priceDisplay), each through formatUnitPrice in
 * the company currency and the display language, plus the tax note variables.
 * A null tariff gives empty prices and no tax note.
 */
export function buildStationPriceContext(input: {
  tariff: {
    pricePerKwh: string | number | null;
    pricePerMinute: string | number | null;
    pricePerSession: string | number | null;
    idleFeePricePerMinute: string | number | null;
    taxRate: string | number | null;
  } | null;
  priceDisplay: PriceDisplay;
  /** The tax basis the tariff prices are entered in (company.taxBasis). */
  taxBasis: TaxBasis;
  pricingFormat: string;
  currency: string;
  language: StationMessageLanguage;
}): StationPriceContext {
  const { tariff, priceDisplay, currency, language } = input;
  if (tariff == null) {
    return {
      pricingDisplay: '',
      energyPrice: '',
      timePrice: '',
      sessionFee: '',
      idleFee: '',
      taxRatePercent: '',
      pricesIncludeTax: false,
    };
  }
  const view = tariffPriceView(tariff, priceDisplay, input.taxBasis);
  const format = input.pricingFormat === 'standard' ? 'standard' : 'compact';
  const price = (value: number | null): string =>
    value == null ? '' : formatUnitPrice(value, currency, language);
  return {
    pricingDisplay: formatTariffSummary(
      view,
      STATION_PRICE_SUMMARY_LABELS[language][format],
      currency,
      language,
    ),
    energyPrice: price(view.energy),
    timePrice: price(view.time),
    sessionFee: view.session == null ? '' : formatFlatPrice(view.session, currency, language),
    idleFee: price(view.idle),
    ...stationTaxNoteContext(view.taxRate, priceDisplay, language),
  };
}

/**
 * The `idleFeeRate` variable: the idle fee per minute (stored in the tax
 * basis) as the company shows prices, with the per-minute unit of the display
 * language ("0,119 €/Min."). Empty when there is no idle fee.
 */
export function formatStationIdleFeeRate(input: {
  pricePerMinute: string | number | null;
  taxRate: string | number | null;
  priceDisplay: PriceDisplay;
  taxBasis: TaxBasis;
  currency: string;
  language: StationMessageLanguage;
}): string {
  const price = unitPriceForDisplay(
    input.pricePerMinute,
    input.taxRate,
    input.priceDisplay,
    input.taxBasis,
  );
  if (price == null) return '';
  return formatUnitPriceWithLabel(
    price,
    STATION_PER_MINUTE_LABELS[input.language],
    input.currency,
    input.language,
  );
}

/**
 * A clock time on a station screen in the display language ("3:45 PM",
 * "15:45"), in the given time zone (the station's site) or the process's.
 */
export function formatStationTime(
  date: Date,
  language: StationMessageLanguage,
  timeZone?: string,
): string {
  return date.toLocaleTimeString(resolveLocale(language), {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone != null ? { timeZone } : {}),
  });
}

/**
 * Time since a session started, in the display language through
 * Intl.DurationFormat narrow style: "12m", "1h 5m" (en), "1시간 5분" (ko).
 * Unit names come from the runtime's CLDR data and can change between Node
 * releases (German: "1 Std., 5 Min." in CLDR 47, "1h, 5 Min." in CLDR 48).
 * Empty for a missing or future start.
 */
export function formatStationElapsed(
  startedAt: Date | string | null,
  language: StationMessageLanguage,
  now: number = Date.now(),
): string {
  if (startedAt == null) return '';
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const ms = now - start.getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const format = new Intl.DurationFormat(resolveLocale(language), {
    style: 'narrow',
    minutesDisplay: 'always',
  });
  return format.format(hours > 0 ? { hours, minutes } : { minutes });
}

/** A measurement (kWh, kW) with one decimal in the display language ("12.4", "12,4"). */
export function formatStationQuantity(value: number, language: StationMessageLanguage): string {
  return formatNumber(value, language, 1);
}

interface CachedTemplate {
  cacheKey: string;
  template: Handlebars.TemplateDelegate;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const templateCache = new Map<string, CachedTemplate>();

export function clearStationMessageCache(): void {
  templateCache.clear();
}

interface DatabaseModule {
  db: {
    select: (selection: Record<string, unknown>) => {
      from: (table: unknown) => {
        where: (cond: unknown) => Promise<Array<{ body: string; updatedAt: Date }>>;
      };
    };
  };
  stationMessageTemplates: {
    body: unknown;
    updatedAt: unknown;
    state: unknown;
    language: unknown;
  };
  getStationMessageLanguage: () => Promise<string>;
}

async function loadDatabase(): Promise<DatabaseModule> {
  return (await import('@evtivity/database')) as unknown as DatabaseModule;
}

/**
 * Renders the operator's template for a state in a display language. Without
 * a language, the `stationMessage.language` setting decides (one-shot
 * messages). Returns '' when no template row exists.
 */
export async function renderStationMessage(
  state: StationMessageState,
  ctx: StationMessageContext,
  language?: StationMessageLanguage,
): Promise<string> {
  let lang: StationMessageLanguage = DEFAULT_STATION_MESSAGE_LANGUAGE;
  if (language != null) {
    lang = language;
  } else {
    const configured = await (await loadDatabase()).getStationMessageLanguage();
    if (isStationMessageLanguage(configured)) lang = configured;
  }

  const key = `${state}:${lang}`;
  const cached = templateCache.get(key);
  let template: Handlebars.TemplateDelegate | null = null;

  if (cached != null && cached.expiresAt > Date.now()) {
    template = cached.template;
  } else {
    const dbModule = await loadDatabase();
    const drizzle = (await import('drizzle-orm')) as unknown as {
      eq: (left: unknown, right: unknown) => unknown;
      and: (...conditions: unknown[]) => unknown;
    };

    const rows = await dbModule.db
      .select({
        body: dbModule.stationMessageTemplates.body,
        updatedAt: dbModule.stationMessageTemplates.updatedAt,
      })
      .from(dbModule.stationMessageTemplates)
      .where(
        drizzle.and(
          drizzle.eq(dbModule.stationMessageTemplates.state, state),
          drizzle.eq(dbModule.stationMessageTemplates.language, lang),
        ),
      );

    const row = rows[0];
    if (row == null) {
      return '';
    }

    const cacheKey = `${key}:${row.updatedAt.getTime().toString()}`;
    if (cached != null && cached.cacheKey === cacheKey) {
      cached.expiresAt = Date.now() + CACHE_TTL_MS;
      template = cached.template;
    } else {
      template = Handlebars.compile(row.body, { noEscape: true });
      templateCache.set(key, {
        cacheKey,
        template,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
  }

  const renderContext: Record<string, string | boolean> = {
    companyName: ctx.companyName,
    brandLine:
      ctx.brandLine != null && ctx.brandLine.trim() !== '' ? ctx.brandLine : ctx.companyName,
    stationOcppId: ctx.stationOcppId,
    pricingDisplay: ctx.pricingDisplay ?? '',
    energyPrice: ctx.energyPrice ?? '',
    timePrice: ctx.timePrice ?? '',
    sessionFee: ctx.sessionFee ?? '',
    idleFee: ctx.idleFee ?? '',
    taxRatePercent: ctx.taxRatePercent ?? '',
    pricesIncludeTax: ctx.pricesIncludeTax ?? false,
    energyKwh: ctx.energyKwh ?? '',
    powerKw: ctx.powerKw ?? '',
    costFormatted: ctx.costFormatted ?? '',
    elapsedFormatted: ctx.elapsedFormatted ?? '',
    idleFeeRate: ctx.idleFeeRate ?? '',
    supportPhone: ctx.supportPhone ?? '',
    driverFirstName: ctx.driverFirstName ?? '',
    reservationExpiresAt: ctx.reservationExpiresAt ?? '',
  };

  return template(renderContext);
}
