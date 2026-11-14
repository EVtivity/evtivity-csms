// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, Minus, Clock } from 'lucide-react';
import {
  priceForDisplay,
  resolveTaxBasis,
  type PriceDisplay,
  type TaxBasis,
} from '@evtivity/lib/price-display';
import { isTariffFree } from '@evtivity/lib/payment-helpers';
import { formatFlatPrice, formatTaxPercent, formatUnitPrice } from '@/lib/utils';
import type { DriverBilling } from '@/lib/fleet-billing';

export interface TariffRestrictionsLite {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

export interface PricingInfo {
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  /** Reservation holding fee per minute (the no-show fee of a reservation made now). */
  reservationFeePerMinute?: string | null;
  taxRate: string | null;
  /** How the prices are entered: excluding ('net') or including ('gross') tax. */
  taxBasis?: TaxBasis;
  isFreeVend?: boolean;
  restrictions?: TariffRestrictionsLite | null;
  /** How the driver pays a session started here; null at a free vend site. */
  billing?: DriverBilling | null;
  /** IANA timezone of the site, the one time and day restrictions are evaluated in. */
  timezone?: string | null;
  /** True when the price can switch mid-session (split billing with restricted tariffs). */
  priceChangesDuringSession?: boolean;
  /** Split billing can move a free start to a paid tariff (needs a payment method). */
  paidTariffAhead?: boolean;
  /**
   * The AC and DC prices of a station with AC and DC EVSEs whose prices
   * differ (AC and DC tariffs), shown side by side. Empty or absent otherwise.
   */
  byChargingKind?: ChargingKindPrice[];
  /** Free or paid per EVSE for this driver, as the start decides it. */
  evseFree?: Array<{ evseId: number; free: boolean }>;
}

export interface ChargingKindPrice {
  chargingKind: 'ac' | 'dc';
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  taxRate: string | null;
  restrictions?: TariffRestrictionsLite | null;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function formatRestrictions(
  r: TariffRestrictionsLite | null | undefined,
  t: TFunction,
): string | null {
  if (r == null) return null;
  if (r.energyThresholdKwh != null) {
    return t('charger.restrictionEnergyThreshold', { kwh: r.energyThresholdKwh });
  }
  if (r.holidays === true) return t('charger.restrictionHolidays');
  if (r.dateRange != null) {
    return t('charger.restrictionDateRange', {
      start: r.dateRange.startDate,
      end: r.dateRange.endDate,
    });
  }
  const parts: string[] = [];
  if (r.daysOfWeek != null && r.daysOfWeek.length > 0) {
    const names = r.daysOfWeek
      .map((d) => {
        const key = DAY_KEYS[d];
        return key != null ? t(`charger.day.${key}`) : null;
      })
      .filter((s): s is string => s != null);
    if (names.length > 0) parts.push(names.join(', '));
  }
  if (r.timeRange != null) {
    parts.push(`${r.timeRange.startTime}–${r.timeRange.endTime}`);
  } else if (parts.length > 0) {
    // Days without a time window apply for the whole day.
    parts.push(t('charger.restrictionAllDay'));
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** True when the restriction depends on the time of day or the day of week. */
function hasTimeOrDayRestriction(r: TariffRestrictionsLite | null | undefined): boolean {
  if (r == null) return false;
  return r.timeRange != null || (r.daysOfWeek != null && r.daysOfWeek.length > 0);
}

interface PriceLines {
  /** The headline price (energy, else time, else the session fee, else Free). */
  main: string;
  /** Energy, time, session fee and idle fee, each when above 0. */
  lines: string[];
  taxNote: string | null;
}

/** A tariff's price lines as the driver sees them, in its own tax rate. */
function priceLines(
  prices: Pick<
    ChargingKindPrice,
    'pricePerKwh' | 'pricePerMinute' | 'pricePerSession' | 'idleFeePricePerMinute' | 'taxRate'
  >,
  currency: string,
  basis: TaxBasis,
  priceDisplay: PriceDisplay,
  t: TFunction,
): PriceLines {
  const rate = prices.taxRate != null ? Number(prices.taxRate) : 0;
  const shown = (price: number): number => priceForDisplay(price, rate, priceDisplay, basis);
  const unit = (price: number): string => formatUnitPrice(shown(price), currency);
  // A session fee is a flat amount, shown rounded to the cent as it is billed.
  const flat = (price: number): string => formatFlatPrice(shown(price), currency);
  const kwh = Number(prices.pricePerKwh ?? 0);
  const min = Number(prices.pricePerMinute ?? 0);
  const fee = Number(prices.pricePerSession ?? 0);
  const idle = Number(prices.idleFeePricePerMinute ?? 0);
  const main =
    kwh > 0
      ? `${unit(kwh)}/${t('charger.unitKwh')}`
      : min > 0
        ? `${unit(min)}/${t('charger.unitMin')}`
        : fee > 0
          ? flat(fee)
          : t('charger.pricingFree');
  const lines: string[] = [];
  if (kwh > 0) lines.push(`${unit(kwh)} ${t('charger.perKwh')}`);
  if (min > 0) lines.push(`${unit(min)} ${t('charger.perMin')}`);
  if (fee > 0) lines.push(`${flat(fee)} ${t('charger.sessionFee')}`);
  if (idle > 0) lines.push(`${unit(idle)} ${t('charger.idleFee')}`);
  const taxNote =
    rate > 0
      ? t(priceDisplay === 'gross' ? 'charger.taxIncluded' : 'charger.taxExcluded', {
          rate: formatTaxPercent(rate),
        })
      : null;
  return { main, lines, taxNote };
}

// Tariff prices are entered in the company tax basis (net by default). Every
// price is shown as the driver's price display asks, with the tax rate added
// or taken out; the note below the price says which one it is.
export function PricingDisplay({
  pricing,
  priceDisplay,
}: {
  pricing: PricingInfo;
  priceDisplay: PriceDisplay;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const basis = resolveTaxBasis(pricing.taxBasis);
  const kinds = pricing.byChargingKind ?? [];
  const timezoneLabel =
    pricing.timezone != null &&
    [pricing.restrictions, ...kinds.map((k) => k.restrictions)].some(hasTimeOrDayRestriction)
      ? t('charger.restrictionTimezone', { timezone: pricing.timezone })
      : null;
  const priceChangeNote =
    pricing.priceChangesDuringSession === true ? (
      <p className="text-center text-xs text-muted-foreground">
        {t('charger.priceChangesDuringSession')}
      </p>
    ) : null;

  if (pricing.isFreeVend === true) {
    return (
      <div className="text-center space-y-1">
        <p className="text-base font-semibold text-success">{t('charger.freeVendBadge')}</p>
        <p className="text-xs text-muted-foreground">{t('charger.freeVendDescription')}</p>
      </div>
    );
  }

  // AC and DC prices differ: the station is free only when every kind is
  // free (the Both tariff above them may be a free placeholder no session pays).
  const free = kinds.length > 1 ? kinds.every((k) => isTariffFree(k)) : isTariffFree(pricing);
  if (free) {
    return (
      <div className="space-y-1">
        <p className="text-base text-muted-foreground text-center">{t('charger.pricingFree')}</p>
        {priceChangeNote}
      </div>
    );
  }

  if (kinds.length > 1) {
    return (
      <ChargingKindPrices
        kinds={kinds}
        currency={pricing.currency}
        basis={basis}
        priceDisplay={priceDisplay}
        timezoneLabel={timezoneLabel}
        priceChangeNote={priceChangeNote}
      />
    );
  }

  const view = priceLines(pricing, pricing.currency, basis, priceDisplay, t);
  const restrictionLabel = formatRestrictions(pricing.restrictions, t);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex items-center justify-center gap-2 w-full"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        <span className="text-base font-semibold text-link">{view.main}</span>
        {expanded ? (
          <Minus className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Plus className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {view.taxNote != null && (
        <p className="text-center text-xs text-muted-foreground">{view.taxNote}</p>
      )}
      {restrictionLabel != null && (
        <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {restrictionLabel}
        </p>
      )}
      {timezoneLabel != null && (
        <p className="text-center text-xs text-muted-foreground">{timezoneLabel}</p>
      )}
      {priceChangeNote}
      <div id={detailsId} hidden={!expanded} className="space-y-0.5 text-center">
        {view.lines.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** AC and DC side by side, each with its own price lines, tax note and conditions. */
function ChargingKindPrices({
  kinds,
  currency,
  basis,
  priceDisplay,
  timezoneLabel,
  priceChangeNote,
}: {
  kinds: ChargingKindPrice[];
  currency: string;
  basis: TaxBasis;
  priceDisplay: PriceDisplay;
  timezoneLabel: string | null;
  priceChangeNote: React.JSX.Element | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const views = kinds.map((k) => ({
    kind: k.chargingKind,
    label: t(k.chargingKind === 'ac' ? 'charger.chargingKindAc' : 'charger.chargingKindDc'),
    restriction: formatRestrictions(k.restrictions, t),
    ...priceLines(k, currency, basis, priceDisplay, t),
  }));
  // One tax note when every kind has the same one, else one under each kind.
  const sharedTaxNote = new Set(kinds.map((k) => Number(k.taxRate ?? 0))).size === 1;
  const sharedNote = sharedTaxNote ? (views[0]?.taxNote ?? null) : null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full items-start justify-center gap-6"
        data-testid="pricing-by-kind"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={t('charger.priceDetailsToggle')}
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        {views.map((v) => (
          <span key={v.kind} className="text-center">
            <span className="block text-xs text-muted-foreground">{v.label}</span>
            <span className="block text-base font-semibold text-link">{v.main}</span>
          </span>
        ))}
        {expanded ? (
          <Minus className="mt-5 h-4 w-4 text-muted-foreground" />
        ) : (
          <Plus className="mt-5 h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {sharedNote != null && (
        <p className="text-center text-xs text-muted-foreground">{sharedNote}</p>
      )}
      {timezoneLabel != null && (
        <p className="text-center text-xs text-muted-foreground">{timezoneLabel}</p>
      )}
      {priceChangeNote}
      <div
        id={detailsId}
        hidden={!expanded}
        className="grid grid-cols-2 items-start gap-4 text-center"
        data-testid="pricing-by-kind-details"
      >
        {views.map((v) => (
          <div key={v.kind} className="space-y-0.5">
            <p className="text-xs font-medium text-muted-foreground">{v.label}</p>
            {v.lines.map((line) => (
              <p key={line} className="text-sm text-muted-foreground">
                {line}
              </p>
            ))}
            {!sharedTaxNote && v.taxNote != null && (
              <p className="text-xs text-muted-foreground">{v.taxNote}</p>
            )}
            {v.restriction != null && (
              <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {v.restriction}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
