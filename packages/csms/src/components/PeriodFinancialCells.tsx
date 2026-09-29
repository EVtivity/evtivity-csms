// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatCents } from '@/lib/formatting';
import { splitPrimary, type PeriodFinancial } from '@/lib/currency-amounts';
import { OtherCurrencyAmounts } from '@/components/OtherCurrencyAmounts';

/** Money cells for the site and station metrics grids, one value per currency. */
export function PeriodFinancialCells({
  financials,
}: {
  financials: PeriodFinancial[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { primary, others } = splitPrimary(financials);
  const currency = primary?.currency;

  function moneyCell(
    label: string,
    amount: (f: PeriodFinancial) => number,
    className = '',
  ): React.JSX.Element {
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold ${className}`}>
          {formatCents(primary != null ? amount(primary) : 0, currency)}
        </p>
        <OtherCurrencyAmounts entries={others} amount={amount} />
      </div>
    );
  }

  const profit = primary?.totalProfitCents ?? 0;

  return (
    <>
      {moneyCell(t('metrics.totalRevenue'), (f) => f.totalRevenueCents)}
      {moneyCell(t('metrics.revenuePerSession'), (f) => f.avgRevenueCentsPerSession)}
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{t('metrics.totalTransactions')}</p>
        <p className="text-2xl font-bold">
          {String(financials.reduce((sum, f) => sum + f.totalTransactions, 0))}
        </p>
      </div>
      {moneyCell(t('metrics.electricityCost'), (f) => f.totalElectricityCostCents)}
      {moneyCell(
        t('metrics.profit'),
        (f) => f.totalProfitCents,
        profit >= 0 ? 'text-success' : 'text-destructive',
      )}
    </>
  );
}
