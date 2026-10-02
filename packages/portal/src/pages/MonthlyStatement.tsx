// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import {
  formatCents,
  formatEnergy,
  formatDuration,
  formatDistance,
  formatDate,
  formatNumber,
} from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { useAuth } from '@/lib/auth';
import { costContainsTax } from '@evtivity/lib/price-display';

interface StatementSession {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  taxCents: number | null;
  currency: string;
  siteName: string | null;
  siteCity: string | null;
  co2AvoidedKg: number | null;
}

interface StatementResponse {
  month: string;
  driverName: string;
  sessions: StatementSession[];
  totals: {
    totalCostCents: number;
    currency: string;
    totalEnergyWh: number;
    sessionCount: number;
    totalCo2AvoidedKg: number | null;
  };
}

function monthLabel(month: string, locale: string): string {
  const [yearStr, monthStr] = month.split('-');
  const date = new Date(Number(yearStr), Number(monthStr) - 1, 1);
  const end = new Date(Number(yearStr), Number(monthStr), 0);
  // e.g. "October 1 – 31, 2026" (en) or "1.–31. Oktober 2026" (de)
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).formatRange(date, end);
}

export function MonthlyStatement(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const timezone = useDriverTimezone();
  const distanceUnit = useAuth((s) => s.driver?.distanceUnit ?? 'miles');
  const [searchParams] = useSearchParams();

  const now = new Date();
  const month =
    searchParams.get('month') ??
    `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { data, isLoading } = useQuery({
    queryKey: ['portal-monthly-statement', month],
    queryFn: () =>
      api.get<StatementResponse>(`/v1/portal/sessions/monthly-statement?month=${month}`),
  });

  const { data: efficiencyData } = useQuery({
    queryKey: ['portal-vehicle-efficiency'],
    queryFn: () => api.get<{ efficiencyMiPerKwh: number }>('/v1/portal/vehicles/efficiency'),
  });
  const efficiency = efficiencyData?.efficiencyMiPerKwh ?? 3.5;
  const hasCo2Data = data?.sessions.some((s) => s.co2AvoidedKg != null) === true;
  // The cost column (and its total) reads "incl. tax" only when a session's
  // cost actually contains tax, the rule the session lists label each row by.
  const costsIncludeTax =
    data?.sessions.some((s) => costContainsTax(s.finalCostCents, s.taxCents)) === true;

  return (
    <div className="space-y-4">
      <PageHeader title={t('statement.title')} />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {data != null && (
        <>
          <div className="space-y-1">
            <p className="text-sm font-medium">{data.driverName}</p>
            <p className="text-xs text-muted-foreground">
              {t('statement.period')}: {monthLabel(data.month, i18n.language)}
            </p>
          </div>

          {data.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t('statement.noSessions')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2">{t('statement.location')}</th>
                    <th className="px-2 py-2 text-right">{t('activity.energy')}</th>
                    <th className="hidden md:table-cell px-2 py-2 text-right">
                      {t('statement.duration')}
                    </th>
                    <th className="hidden md:table-cell px-2 py-2 text-right">
                      {t('statement.miles')}
                    </th>
                    <th className="px-2 py-2 text-right">
                      {costsIncludeTax ? t('statement.costInclTax') : t('statement.cost')}
                    </th>
                    {hasCo2Data && (
                      <th className="hidden md:table-cell px-2 py-2 text-right">
                        {t('statement.co2Avoided')}
                      </th>
                    )}
                    <th className="hidden md:table-cell px-2 py-2 text-right">
                      {t('statement.date')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="px-2 py-2">
                        {s.siteName ?? 'n/a'}
                        {s.siteCity != null && (
                          <span className="text-xs text-muted-foreground">, {s.siteCity}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">{formatEnergy(s.energyDeliveredWh)}</td>
                      <td className="hidden md:table-cell px-2 py-2 text-right">
                        {formatDuration(s.startedAt, s.endedAt)}
                      </td>
                      <td className="hidden md:table-cell px-2 py-2 text-right">
                        {formatDistance(s.energyDeliveredWh, efficiency, distanceUnit)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {formatCents(s.finalCostCents, s.currency)}
                      </td>
                      {hasCo2Data && (
                        <td className="hidden md:table-cell px-2 py-2 text-right text-success">
                          {s.co2AvoidedKg != null ? `${formatNumber(s.co2AvoidedKg, 2)} kg` : 'n/a'}
                        </td>
                      )}
                      <td className="hidden md:table-cell px-2 py-2 text-right text-xs whitespace-nowrap">
                        {formatDate(s.startedAt, timezone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="px-2 py-2">{t('statement.total')}</td>
                    <td className="px-2 py-2 text-right">
                      {formatEnergy(data.totals.totalEnergyWh)}
                    </td>
                    <td className="hidden md:table-cell px-2 py-2 text-right">n/a</td>
                    <td className="hidden md:table-cell px-2 py-2 text-right">
                      {formatDistance(data.totals.totalEnergyWh, efficiency, distanceUnit)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {formatCents(data.totals.totalCostCents, data.totals.currency)}
                    </td>
                    {hasCo2Data && (
                      <td className="hidden md:table-cell px-2 py-2 text-right text-success">
                        {data.totals.totalCo2AvoidedKg != null
                          ? `${formatNumber(data.totals.totalCo2AvoidedKg, 2)} kg`
                          : 'n/a'}
                      </td>
                    )}
                    <td className="hidden md:table-cell px-2 py-2 text-right">n/a</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
