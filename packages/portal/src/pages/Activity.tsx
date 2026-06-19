// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery, useQueries } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, Leaf } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import {
  formatCents,
  formatEnergy,
  formatDuration,
  formatDistance,
  formatMonthYear,
} from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { LoadingLogo } from '@/components/loading-logo';
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

// Trailing-trend chart height in px (matches the mobile app's 6-month bars).
const CHART_HEIGHT = 110;

function shiftMonthParam(date: Date, delta: number): string {
  return formatMonthParam(new Date(date.getFullYear(), date.getMonth() + delta, 1));
}

function monthParamToDate(param: string): Date {
  const [y, m] = param.split('-');
  return new Date(Number(y), Number(m) - 1, 1);
}

function monthAbbrev(param: string): string {
  return monthParamToDate(param).toLocaleDateString('en-US', { month: 'short' });
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

  // Trailing 6 months ending at the selected month, for the trend chart. Each
  // month shares its cache key with the single-month summary above, so the
  // selected month is not fetched twice.
  const trendMonths = Array.from({ length: 6 }, (_, k) => shiftMonthParam(selectedMonth, k - 5));
  const trendQueries = useQueries({
    queries: trendMonths.map((m) => ({
      queryKey: ['portal-monthly-summary', m],
      queryFn: () => api.get<MonthlySummary>(`/v1/portal/sessions/monthly-summary?month=${m}`),
    })),
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

  let centerText = 'n/a';
  if (selectedMetric === 'cost') {
    centerText = formatCents(totalCost, currency);
  } else if (selectedMetric === 'energy') {
    centerText = formatEnergy(totalEnergyWh);
  } else if (distanceUnit === 'km') {
    const totalKm = totalMiles * 1.60934;
    centerText = `${totalKm.toFixed(0)} ${t('activity.km')}`;
  } else {
    centerText = `${totalMiles.toFixed(0)} ${t('activity.miles')}`;
  }

  // Per-month value for the trend bars. Energy and distance scale together, so
  // both use total energy; cost uses total cost.
  const metricValue = (s: MonthlySummary | undefined): number => {
    if (s == null) return 0;
    if (selectedMetric === 'cost') return s.totalCostCents;
    return s.totalEnergyWh;
  };
  const trendValues = trendQueries.map((q) => metricValue(q.data));
  const trendMax = Math.max(...trendValues, 1);
  const trendLoading = trendQueries.some((q) => q.isLoading);

  const sessionList = sessionsPages?.pages.flatMap((p) => p.data) ?? [];

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
                amount: summary.totalCo2AvoidedKg.toFixed(1),
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

      {/* 6-month trend */}
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="text-center">
            <p className="text-xl font-bold">{centerText}</p>
            <p className="text-xs text-muted-foreground">
              {summary?.sessionCount ?? 0} {t('activity.sessions')}
            </p>
          </div>
          {trendLoading ? (
            <div className="flex justify-center">
              <LoadingLogo size="inline" />
            </div>
          ) : (
            <div
              className="flex items-end justify-between gap-2"
              style={{ height: CHART_HEIGHT + 28 }}
            >
              {trendMonths.map((m, i) => {
                const active = m === monthParam;
                const value = trendValues[i] ?? 0;
                const barHeight = Math.max((value / trendMax) * CHART_HEIGHT, value > 0 ? 6 : 2);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-label={m}
                    onClick={() => {
                      setSelectedMonth(monthParamToDate(m));
                    }}
                    className="flex flex-1 flex-col items-center gap-1.5"
                  >
                    <div
                      style={{ height: barHeight }}
                      className={`w-full rounded-t-md transition-colors ${
                        active ? 'bg-primary' : 'bg-muted-foreground/25'
                      }`}
                    />
                    <span
                      className={`text-xs ${
                        active ? 'font-semibold text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {monthAbbrev(m)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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
        {isFetchingNextPage && <LoadingLogo size="inline" />}
      </div>
    </div>
  );
}
