// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, Minus, Clock } from 'lucide-react';
import { formatNumber, formatPrice } from '@/lib/utils';

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
  taxRate: string | null;
  isFreeVend?: boolean;
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
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export function PricingDisplay({ pricing }: { pricing: PricingInfo }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const perKwh = pricing.pricePerKwh != null ? Number(pricing.pricePerKwh) : 0;
  const perMin = pricing.pricePerMinute != null ? Number(pricing.pricePerMinute) : 0;
  const perSession = pricing.pricePerSession != null ? Number(pricing.pricePerSession) : 0;
  const idleFee = pricing.idleFeePricePerMinute != null ? Number(pricing.idleFeePricePerMinute) : 0;
  const taxRate = pricing.taxRate != null ? Number(pricing.taxRate) : 0;
  const restrictionLabel = formatRestrictions(pricing.restrictions, t);

  if (pricing.isFreeVend === true) {
    return (
      <div className="text-center space-y-1">
        <p className="text-base font-semibold text-success">{t('charger.freeVendBadge')}</p>
        <p className="text-xs text-muted-foreground">{t('charger.freeVendDescription')}</p>
      </div>
    );
  }

  if (perKwh === 0 && perMin === 0 && perSession === 0 && idleFee === 0 && taxRate === 0) {
    return (
      <p className="text-base text-muted-foreground text-center">{t('charger.pricingFree')}</p>
    );
  }

  const primaryPrice =
    perKwh > 0
      ? `${formatPrice(perKwh, pricing.currency)}/${t('charger.unitKwh')}`
      : perMin > 0
        ? `${formatPrice(perMin, pricing.currency)}/${t('charger.unitMin')}`
        : formatPrice(perSession, pricing.currency);

  const breakdownLines: string[] = [];
  if (perKwh > 0)
    breakdownLines.push(`${formatPrice(perKwh, pricing.currency)} ${t('charger.perKwh')}`);
  if (perMin > 0)
    breakdownLines.push(`${formatPrice(perMin, pricing.currency)} ${t('charger.perMin')}`);
  if (perSession > 0)
    breakdownLines.push(`${formatPrice(perSession, pricing.currency)} ${t('charger.sessionFee')}`);
  if (idleFee > 0)
    breakdownLines.push(`${formatPrice(idleFee, pricing.currency)} ${t('charger.idleFee')}`);
  if (taxRate > 0) breakdownLines.push(`${formatNumber(taxRate * 100, 0)}% ${t('charger.tax')}`);

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
      {restrictionLabel != null && (
        <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {restrictionLabel}
        </p>
      )}
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

export function isPricingFree(pricing: PricingInfo): boolean {
  const perKwh = pricing.pricePerKwh != null ? Number(pricing.pricePerKwh) : 0;
  const perMin = pricing.pricePerMinute != null ? Number(pricing.pricePerMinute) : 0;
  const perSession = pricing.pricePerSession != null ? Number(pricing.pricePerSession) : 0;
  const idleFee = pricing.idleFeePricePerMinute != null ? Number(pricing.idleFeePricePerMinute) : 0;
  return perKwh === 0 && perMin === 0 && perSession === 0 && idleFee === 0;
}
