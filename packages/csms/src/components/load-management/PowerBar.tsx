// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/formatting';

interface PowerBarProps {
  currentKw: number;
  limitKw: number;
  maxKw: number;
  label?: string;
  /**
   * Battery and solar supply credited on top of the grid capacity, kW. Drawn
   * as its own segment after `maxKw`, so the grid capacity and the local
   * supply read apart.
   */
  creditKw?: number;
}

function getBarColor(percentage: number): string {
  if (percentage >= 95) return 'bg-destructive';
  if (percentage >= 80) return 'bg-warning';
  return 'bg-success';
}

export function PowerBar({
  currentKw,
  limitKw,
  maxKw,
  label,
  creditKw = 0,
}: PowerBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const credit = creditKw > 0 ? creditKw : 0;
  const effectiveMax = maxKw > 0 ? maxKw : Math.max(currentKw, limitKw, 1);
  const total = effectiveMax + credit;
  const currentPercent = Math.min(100, (currentKw / total) * 100);
  const limitPercent = limitKw > 0 ? Math.min(100, (limitKw / total) * 100) : 0;
  const gridPercent = (effectiveMax / total) * 100;
  const usableKw = limitKw > 0 ? limitKw + credit : 0;
  const usagePercent = usableKw > 0 ? (currentKw / usableKw) * 100 : 0;

  return (
    <div className="space-y-1">
      {label != null && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="relative h-6 w-full rounded-sm bg-muted overflow-hidden">
        {credit > 0 && (
          <div
            data-testid="power-bar-credit"
            className="absolute top-0 h-full bg-info/25 border-l-2 border-info"
            style={{ left: `${String(gridPercent)}%`, width: `${String(100 - gridPercent)}%` }}
          />
        )}
        <div
          className={cn(
            'relative h-full rounded-l-sm transition-all duration-500',
            getBarColor(usagePercent),
          )}
          style={{ width: `${String(currentPercent)}%` }}
        />
        {limitPercent > 0 && (
          <div
            className="absolute top-0 h-full w-0.5 border-l-2 border-dashed border-foreground/50"
            style={{ left: `${String(limitPercent)}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
        <span>{formatNumber(currentKw, 1)} kW</span>
        {limitKw > 0 && (
          <span>{t('loadManagement.powerBarLimit', { kw: formatNumber(limitKw, 1) })}</span>
        )}
        <span>{t('loadManagement.powerBarMax', { kw: formatNumber(effectiveMax, 1) })}</span>
        {credit > 0 && (
          <span className="text-info">
            {t('loadManagement.powerBarLocalSupply', { kw: formatNumber(credit, 1) })}
          </span>
        )}
      </div>
    </div>
  );
}
