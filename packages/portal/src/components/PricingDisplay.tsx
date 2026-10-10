// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
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
  const perKwh = pricing.pricePerKwh != null ? Number(pricing.pricePerKwh) : 0;
  const perMin = pricing.pricePerMinute != null ? Number(pricing.pricePerMinute) : 0;
  const perSession = pricing.pricePerSession != null ? Number(pricing.pricePerSession) : 0;
  const idleFee = pricing.idleFeePricePerMinute != null ? Number(pricing.idleFeePricePerMinute) : 0;
  const taxRate = pricing.taxRate != null ? Number(pricing.taxRate) : 0;
  const displayed = (price: number): number =>
    priceForDisplay(price, taxRate, priceDisplay, resolveTaxBasis(pricing.taxBasis));
  const formatPrice = (price: number): string =>
    formatUnitPrice(displayed(price), pricing.currency);
  // A session fee is a flat amount, shown rounded to the cent as it is billed.
  const formatFee = (price: number): string => formatFlatPrice(displayed(price), pricing.currency);
  const restrictionLabel = formatRestrictions(pricing.restrictions, t);
  const timezoneLabel =
    pricing.timezone != null && hasTimeOrDayRestriction(pricing.restrictions)
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

  // Free when every price is zero, whatever the tax rate (same rule as the server).
  if (isTariffFree(pricing)) {
    return (
      <div className="space-y-1">
        <p className="text-base text-muted-foreground text-center">{t('charger.pricingFree')}</p>
        {priceChangeNote}
      </div>
    );
  }

  const primaryPrice =
    perKwh > 0
      ? `${formatPrice(perKwh)}/${t('charger.unitKwh')}`
      : perMin > 0
        ? `${formatPrice(perMin)}/${t('charger.unitMin')}`
        : formatFee(perSession);

  const breakdownLines: string[] = [];
  if (perKwh > 0) breakdownLines.push(`${formatPrice(perKwh)} ${t('charger.perKwh')}`);
  if (perMin > 0) breakdownLines.push(`${formatPrice(perMin)} ${t('charger.perMin')}`);
  if (perSession > 0) breakdownLines.push(`${formatFee(perSession)} ${t('charger.sessionFee')}`);
  if (idleFee > 0) breakdownLines.push(`${formatPrice(idleFee)} ${t('charger.idleFee')}`);

  const taxNote =
    taxRate > 0
      ? t(priceDisplay === 'gross' ? 'charger.taxIncluded' : 'charger.taxExcluded', {
          rate: formatTaxPercent(taxRate),
        })
      : null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex items-center justify-center gap-2 w-full"
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        <span className="text-base font-semibold text-primary">{primaryPrice}</span>
        {expanded ? (
          <Minus className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Plus className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {taxNote != null && <p className="text-center text-xs text-muted-foreground">{taxNote}</p>}
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
      {expanded && (
        <div className="space-y-0.5 text-center">
          {breakdownLines.map((line) => (
            <p key={line} className="text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
