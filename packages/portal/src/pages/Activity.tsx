// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, Leaf } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { DonutChart } from '@/components/DonutChart';
import { api } from '@/lib/api';
import {
  formatCents,
  formatEnergy,
  formatDuration,
  formatDistance,
  formatMonthYear,
} from '@/lib/utils';
import { useAuth } from '@/lib/auth';
interface Session {
  id: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  currency: string | null;
  stationName: string | null;
  siteName: string | null;
  siteCity: string | null;
}

interface SessionsResponse {
  data: Session[];
  total: number;
}

interface MonthlySummary {
  totalCostCents: number;
  totalEnergyWh: number;
  sessionCount: number;
  currency: string | null;
  totalCo2AvoidedKg: number | null;
}

type Metric = 'cost' | 'energy' | 'distance';

function statusDotColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-success';
    case 'completed':
      return 'bg-muted-foreground';
    case 'failed':
      return 'bg-destructive';
    default:
      return 'bg-warning';
  }
}

function formatMonthParam(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${String(y)}-${m}`;
}

export function Activity(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const distanceUnit = useAuth((s) => s.driver?.distanceUnit ?? 'miles');
  const [selectedMonth, setSelectedMonth] = useState(() => new Date());
  const [selectedMetric, setSelectedMetric] = useState<Metric>('cost');

  const monthParam = formatMonthParam(selectedMonth);

  const { data: summary } = useQuery({
    queryKey: ['portal-monthly-summary', monthParam],
    queryFn: () =>
      api.get<MonthlySummary>(`/v1/portal/sessions/monthly-summary?month=${monthParam}`),
  });

  const {
    data: sessionsPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['portal-sessions-month', monthParam],
    queryFn: ({ pageParam }) =>
      api.get<SessionsResponse>(
        `/v1/portal/sessions?month=${monthParam}&limit=10&offset=${String(pageParam)}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + p.data.length, 0);
      return fetched < lastPage.total ? fetched : undefined;
    },
  });

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (el == null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting === true && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const { data: efficiencyData } = useQuery({
    queryKey: ['portal-vehicle-efficiency'],
    queryFn: () => api.get<{ efficiencyMiPerKwh: number }>('/v1/portal/vehicles/efficiency'),
  });

  const efficiency = efficiencyData?.efficiencyMiPerKwh ?? 3.5;

  function prevMonth(): void {
    setSelectedMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  }

  function nextMonth(): void {
    const next = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1);
    if (next <= new Date()) {
      setSelectedMonth(next);
    }
  }

  const totalCost = summary?.totalCostCents ?? 0;
  const totalEnergyWh = summary?.totalEnergyWh ?? 0;
  const totalMiles = (totalEnergyWh / 1000) * efficiency;
  const currency = summary?.currency ?? 'USD';

  let donutValue = 0;
  let donutMax = 1;
  let centerText = '--';

  if (selectedMetric === 'cost') {
    donutValue = totalCost;
    donutMax = Math.max(totalCost, 1);
    centerText = formatCents(totalCost, currency);
  } else if (selectedMetric === 'energy') {
    donutValue = totalEnergyWh;
    donutMax = Math.max(totalEnergyWh, 1);
    centerText = formatEnergy(totalEnergyWh);
  } else {
    donutValue = totalMiles;
    donutMax = Math.max(totalMiles, 1);
    if (distanceUnit === 'km') {
      const totalKm = totalMiles * 1.60934;
      centerText = `${totalKm.toFixed(0)} ${t('activity.km')}`;
    } else {
      centerText = `${totalMiles.toFixed(0)} ${t('activity.miles')}`;
    }
  }

  const sessionList = sessionsPages?.pages.flatMap((p) => p.data) ?? [];
  const hasData = (summary?.sessionCount ?? 0) > 0;

  return (
    <div className="space-y-4 pb-20">
      {/* Monthly statement banner */}
      <Card
        className="cursor-pointer hover:shadow-md transition-shadow"
        onClick={() => {
          void navigate(`/activity/statement?month=${monthParam}`);
        }}
      >
        <CardContent className="flex items-center gap-3 p-3">
          <FileText className="h-5 w-5 text-primary" />
          <span className="flex-1 text-sm font-medium">{t('activity.monthlyStatement')}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </CardContent>
      </Card>

      {/* Carbon impact card */}
      {summary?.totalCo2AvoidedKg != null && summary.totalCo2AvoidedKg > 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <Leaf className="h-5 w-5 text-success" />
            <span className="text-sm font-medium text-success">
              {t('activity.co2AvoidedMessage', {
                amount: parseFloat(String(summary.totalCo2AvoidedKg)).toFixed(1),
              })}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Month selector */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={prevMonth}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold">{formatMonthYear(selectedMonth)}</span>
        <button
          onClick={nextMonth}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Next month"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Donut chart */}
      <div className="flex justify-center">
        {hasData ? (
          <DonutChart
            value={donutValue}
            max={donutMax}
            size={160}
            strokeWidth={12}
            label={centerText}
          >
            <div className="text-center">
              <p className="text-xl font-bold">{centerText}</p>
              <p className="text-xs text-muted-foreground">
                {summary?.sessionCount ?? 0} {t('activity.sessions')}
              </p>
            </div>
          </DonutChart>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <p className="text-sm">{t('activity.noChargingThisMonth')}</p>
          </div>
        )}
      </div>

      {/* Metric tabs */}
      <div className="flex rounded-lg border">
        {(['cost', 'energy', 'distance'] as const).map((metric) => (
          <button
            key={metric}
            onClick={() => {
              setSelectedMetric(metric);
            }}
            className={`flex-1 py-2 text-center text-sm font-medium transition-colors ${
              selectedMetric === metric
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            } ${metric === 'cost' ? 'rounded-l-lg' : ''} ${metric === 'distance' ? 'rounded-r-lg' : ''}`}
          >
            {t(`activity.${metric}`)}
          </button>
        ))}
      </div>

      {/* Session list */}
      {sessionList.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('activity.noSessions')}</p>
      )}

      <div className="space-y-2">
        {sessionList.map((session) => (
          <Card
            key={session.id}
            className="cursor-pointer hover:bg-accent/50 transition-colors"
            onClick={() => {
              void navigate(`/sessions/${session.id}`);
            }}
          >
            <CardContent className="flex items-center gap-3 p-3">
              <span
                className={`h-2 w-2 rounded-full ${statusDotColor(session.status)}`}
                aria-hidden="true"
              />
              <span className="sr-only">{session.status}</span>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium">
                  {session.siteName ?? session.stationName ?? t('activity.unknownStation')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {session.siteCity ?? ''}
                  {session.siteCity != null && ' - '}
                  {formatDistance(session.energyDeliveredWh, efficiency, distanceUnit)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium">
                  {formatCents(session.finalCostCents, session.currency ?? 'USD')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDuration(session.startedAt, session.endedAt)}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
        <div ref={sentinelRef} />
        {isFetchingNextPage && (
          <p className="py-2 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
        )}
      </div>
    </div>
  );
}
