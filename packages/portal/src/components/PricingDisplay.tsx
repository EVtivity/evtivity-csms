// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Minus } from 'lucide-react';
import { currencySymbol } from '@/lib/utils';

export interface PricingInfo {
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  taxRate: string | null;
}

export function PricingDisplay({ pricing }: { pricing: PricingInfo }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sym = currencySymbol(pricing.currency);
  const perKwh = pricing.pricePerKwh != null ? Number(pricing.pricePerKwh) : 0;
  const perMin = pricing.pricePerMinute != null ? Number(pricing.pricePerMinute) : 0;
  const perSession = pricing.pricePerSession != null ? Number(pricing.pricePerSession) : 0;
  const idleFee = pricing.idleFeePricePerMinute != null ? Number(pricing.idleFeePricePerMinute) : 0;
  const taxRate = pricing.taxRate != null ? Number(pricing.taxRate) : 0;

  if (perKwh === 0 && perMin === 0 && perSession === 0 && idleFee === 0 && taxRate === 0) {
    return (
      <p className="text-base text-muted-foreground text-center">{t('charger.pricingFree')}</p>
    );
  }

  const primaryPrice =
    perKwh > 0
      ? `${sym}${perKwh.toFixed(2)}/${t('charger.unitKwh')}`
      : perMin > 0
        ? `${sym}${perMin.toFixed(2)}/${t('charger.unitMin')}`
        : `${sym}${perSession.toFixed(2)}`;

  const breakdownLines: string[] = [];
  if (perKwh > 0) breakdownLines.push(`${sym}${perKwh.toFixed(2)} ${t('charger.perKwh')}`);
  if (perMin > 0) breakdownLines.push(`${sym}${perMin.toFixed(2)} ${t('charger.perMin')}`);
  if (perSession > 0)
    breakdownLines.push(`${sym}${perSession.toFixed(2)} ${t('charger.sessionFee')}`);
  if (idleFee > 0) breakdownLines.push(`${sym}${idleFee.toFixed(2)} ${t('charger.idleFee')}`);
  if (taxRate > 0) breakdownLines.push(`${(taxRate * 100).toFixed(0)}% ${t('charger.tax')}`);

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
