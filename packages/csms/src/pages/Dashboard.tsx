// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { EnergyChart } from '@/components/charts/EnergyChart';
import { SessionsChart } from '@/components/charts/SessionsChart';
import { Sparkline } from '@/components/charts/Sparkline';
import { StationStatusChart } from '@/components/charts/StationStatusChart';
import { UtilizationChart } from '@/components/charts/UtilizationChart';
import { PeakUsageChart } from '@/components/charts/PeakUsageChart';
import { StationMapChart } from '@/components/charts/StationMapChart';
import { SessionsTable } from '@/components/SessionsTable';
import type { Session } from '@/components/SessionsTable';
import { useUserTimezone } from '@/lib/timezone';
import { RevenueChart } from '@/components/charts/RevenueChart';
import { PaymentBreakdownChart } from '@/components/charts/PaymentBreakdownChart';
import { DateRangeControl } from '@/components/DateRangeControl';
import { useDateRange } from '@/hooks/useDateRange';

interface DashboardStats {
  totalStations: number;
  onlineStations: number;
  onlinePercent: number;
  activeSessions: number;
  totalSessions: number;
  totalEnergyWh: number;
  faultedStations: number;
  statusCounts: Record<string, number>;
  onboardingStatusCounts: Record<string, number>;
}

interface SnapshotData {
  totalStations: number;
  onlineStations: number;
  onlinePercent: number;
  uptimePercent: number;
  activeSessions: number;
  totalEnergyWh: number;
  dayEnergyWh: number;
  totalSessions: number;
  daySessions: number;
  connectedStations: number;
  totalRevenueCents: number;
  dayRevenueCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
  dayTransactions: number;
  totalPorts: number;
  stationsBelowThreshold: number;
  avgPingLatencyMs: number;
  pingSuccessRate: number;
}

interface TrendDay extends SnapshotData {
  date: string;
}

type DashboardMode = 'live' | 'historical' | 'trend';

interface EnergyPoint {
  date: string;
  energyWh: number;
}

interface SessionPoint {
  date: string;
  count: number;
}

interface StatusPoint {
  status: string;
  count: number;
}

interface UtilizationPoint {
  site: string;
  utilization: number;
}

interface PeakPoint {
  hour: number;
  dayOfWeek: number;
  count: number;
}

interface UptimeStats {
  uptimePercent: number;
  totalPorts: number;
  stationsBelowThreshold: number;
}

interface FinancialStats {
  totalRevenueCents: number;
  todayRevenueCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
  currency: string;
}

interface RevenuePoint {
  date: string;
  revenueCents: number;
  sessionCount: number;
}

interface PaymentBreakdownPoint {
  status: string;
  count: number;
  totalCents: number;
}

interface OcppHealthStats {
  connectedStations: number;
  avgPingLatencyMs: number;
  maxPingLatencyMs: number;
  pingSuccessRate: number;
  totalPingsSent: number;
  totalPongsReceived: number;
  serverStartedAt: string | null;
  updatedAt: string | null;
}

interface CarbonStats {
  totalCo2AvoidedKg: number;
  sessionsWithCo2: number;
}

function parseValue(value: string | number): {
  num: number;
  prefix: string;
  suffix: string;
  decimals: number;
} {
  if (typeof value === 'number') {
    return { num: value, prefix: '', suffix: '', decimals: 0 };
  }
  const match = /^([^0-9-]*)(-?[\d,]+\.?\d*)(.*)$/.exec(value);
  if (match == null) {
    return { num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const raw = match[2] ?? '';
  const num = parseFloat(raw.replace(/,/g, ''));
  if (isNaN(num)) {
    return { num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const dotIndex = raw.indexOf('.');
  const decimals = dotIndex >= 0 ? raw.length - dotIndex - 1 : 0;
  return { num, prefix: match[1] ?? '', suffix: match[3] ?? '', decimals };
}

function formatAnimatedValue(num: number, decimals: number): string {
  if (decimals === 0) {
    return Math.round(num).toLocaleString();
  }
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function useAnimatedValue(value: string | number): string {
  const { num, prefix, suffix, decimals } = parseValue(value);
  const [display, setDisplay] = useState(num);
  const prevRef = useRef(num);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = num;
    prevRef.current = to;

    if (from === to) return;

    const duration = 400;
    const start = performance.now();

    function tick(now: number): void {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [num]);

  return `${prefix}${formatAnimatedValue(display, decimals)}${suffix}`;
}

function computeDelta(current: number | undefined, baseline: number | undefined): number | null {
  if (current == null || baseline == null) return null;
  if (baseline !== 0) return Math.round(((current - baseline) / Math.abs(baseline)) * 1000) / 10;
  return current > 0 ? 100 : 0;
}

function StatCard({
  title,
  value,
  info,
  dayDelta,
  deltaLabel,
  positiveIsGood = true,
  extra,
}: {
  title: string;
  value: string | number;
  info?: string;
  dayDelta?: number | null | undefined;
  deltaLabel?: string | undefined;
  positiveIsGood?: boolean | undefined;
  extra?: React.ReactNode;
}): React.JSX.Element {
  const animated = useAnimatedValue(value);

  const delta = dayDelta ?? null;
  const isPositive = delta != null && delta > 0;
  const isNegative = delta != null && delta < 0;
  const isZero = delta != null && delta === 0;
  const isGood = positiveIsGood ? isPositive : isNegative;
  const isBad = positiveIsGood ? isNegative : isPositive;

  const tooltipText =
    delta != null
      ? isZero
        ? `No change (${deltaLabel ?? ''})`
        : `${isPositive ? '+' : ''}${String(delta)}% (${deltaLabel ?? ''})`
      : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1">
          {title}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-lg sm:text-2xl font-bold whitespace-nowrap flex items-center gap-2">
          {animated}
          {extra}
          {delta != null && tooltipText != null && (
            <InfoTooltip content={<div className="whitespace-nowrap">{tooltipText}</div>}>
              <span
                className={`text-sm cursor-default ${
                  isZero
                    ? 'text-muted-foreground'
                    : isGood
                      ? 'text-success'
                      : isBad
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                }`}
              >
                {isPositive ? '\u2191' : isNegative ? '\u2193' : '\u2192'}
              </span>
            </InfoTooltip>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TrendStatCard({
  title,
  value,
  data,
  info,
  positiveIsGood = true,
}: {
  title: string;
  value: string | number;
  data: number[];
  info?: string;
  positiveIsGood?: boolean;
}): React.JSX.Element {
  const animated = useAnimatedValue(value);
  const first = data[data.length - 1]; // oldest
  const last = data[0]; // newest
  const delta =
    first != null && last != null && first !== 0
      ? Math.round(((last - first) / Math.abs(first)) * 1000) / 10
      : 0;

  const isPositive = delta > 0;
  const isNegative = delta < 0;
  const isGood = positiveIsGood ? isPositive : isNegative;
  const isBad = positiveIsGood ? isNegative : isPositive;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1">
          {title}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-lg sm:text-2xl font-bold whitespace-nowrap">{animated}</div>
        <Sparkline
          data={[...data].reverse()}
          strokeColor={
            isGood
              ? 'hsl(var(--success))'
              : isBad
                ? 'hsl(var(--destructive))'
                : 'hsl(var(--primary))'
          }
          fillColor={
            isGood
              ? 'hsl(var(--success) / 0.1)'
              : isBad
                ? 'hsl(var(--destructive) / 0.1)'
                : 'hsl(var(--primary) / 0.1)'
          }
        />
        {data.length >= 2 && (
          <div
            className={`text-xs font-medium ${
              isGood ? 'text-success' : isBad ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {delta > 0 ? '+' : ''}
            {String(delta)}%
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NoDataOverlay({
  message,
  children,
}: {
  message: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="relative">
      <div className="pointer-events-none select-none blur-sm opacity-50">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="rounded-lg bg-card border border-border px-6 py-3 shadow-sm text-sm text-muted-foreground">
          {message}
        </div>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onModeChange,
  fromDate,
  toDate,
  onFromChange,
  onToChange,
}: {
  mode: DashboardMode;
  onModeChange: (m: DashboardMode) => void;
  fromDate: string;
  toDate: string;
  onFromChange: (d: string) => void;
  onToChange: (d: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const today = new Date().toISOString().split('T')[0] ?? '';
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex rounded-md border border-border">
        {(['live', 'trend', 'historical'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              onModeChange(m);
            }}
            className={`px-3 py-1.5 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md ${
              mode === m
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            {m === 'live' && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
                {t('dashboard.live')}
              </span>
            )}
            {m === 'historical' && t('dashboard.historical')}
            {m === 'trend' && t('dashboard.trend')}
          </button>
        ))}
      </div>
      {mode === 'historical' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            aria-label="Start date"
            value={fromDate}
            onChange={(e) => {
              onFromChange(e.target.value);
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            max={toDate || today}
          />
          <span className="text-sm text-muted-foreground">to</span>
          <input
            type="date"
            aria-label="End date"
            value={toDate}
            onChange={(e) => {
              onToChange(e.target.value);
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            min={fromDate}
            max={today}
          />
        </div>
      )}
    </div>
  );
}

const REFETCH_INTERVAL = 60_000;

function OnboardingStatusBadges({
  counts,
}: {
  counts: Record<string, number>;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const pending = counts['pending'] ?? 0;
  const blocked = counts['blocked'] ?? 0;
  if (pending === 0 && blocked === 0) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pending > 0 && (
        <Badge variant="warning">
          {pending} {t('status.pending')}
        </Badge>
      )}
      {blocked > 0 && (
        <Badge variant="destructive">
          {blocked} {t('status.blocked')}
        </Badge>
      )}
    </div>
  );
}

function AdminDashboard({
  stats,
  mode,
  fromDate,
  toDate,
}: {
  stats: DashboardStats;
  mode: DashboardMode;
  fromDate: string;
  toDate: string;
}): React.JSX.Element {
  const { t } = useTranslation();

  const energy = useDateRange();
  const sessions = useDateRange();
  const utilRange = useDateRange();
  const peak = useDateRange();
  const revenue = useDateRange();

  const uptimeQuery = useQuery({
    queryKey: ['dashboard', 'uptime'],
    queryFn: () => api.get<UptimeStats>('/v1/dashboard/uptime'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const energyHistory = useQuery({
    queryKey: ['dashboard', 'energy-history', energy.dateQuery],
    queryFn: () => api.get<EnergyPoint[]>(`/v1/dashboard/energy-history?${energy.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
  });

  const sessionHistory = useQuery({
    queryKey: ['dashboard', 'session-history', sessions.dateQuery],
    queryFn: () => api.get<SessionPoint[]>(`/v1/dashboard/session-history?${sessions.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
  });

  const stationStatus = useQuery({
    queryKey: ['dashboard', 'station-status'],
    queryFn: () => api.get<StatusPoint[]>('/v1/dashboard/station-status'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const utilization = useQuery({
    queryKey: ['dashboard', 'utilization', utilRange.dateQuery],
    queryFn: () => api.get<UtilizationPoint[]>(`/v1/dashboard/utilization?${utilRange.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
  });

  const peakUsage = useQuery({
    queryKey: ['dashboard', 'peak-usage', peak.dateQuery],
    queryFn: () => api.get<PeakPoint[]>(`/v1/dashboard/peak-usage?${peak.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
  });

  const financialStats = useQuery({
    queryKey: ['dashboard', 'financial-stats'],
    queryFn: () => api.get<FinancialStats>('/v1/dashboard/financial-stats'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const revenueHistory = useQuery({
    queryKey: ['dashboard', 'revenue-history', revenue.dateQuery],
    queryFn: () => api.get<RevenuePoint[]>(`/v1/dashboard/revenue-history?${revenue.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
  });

  const paymentBreakdown = useQuery({
    queryKey: ['dashboard', 'payment-breakdown'],
    queryFn: () => api.get<PaymentBreakdownPoint[]>('/v1/dashboard/payment-breakdown'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const ocppHealth = useQuery({
    queryKey: ['dashboard', 'ocpp-health'],
    queryFn: () => api.get<OcppHealthStats>('/v1/dashboard/ocpp-health'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const carbonStats = useQuery({
    queryKey: ['dashboard', 'carbon-stats'],
    queryFn: () => api.get<CarbonStats>('/v1/dashboard/carbon-stats'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const { yesterdayDate, dayBeforeDate } = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return {
      yesterdayDate: y.toISOString().split('T')[0] ?? '',
      dayBeforeDate: d2.toISOString().split('T')[0] ?? '',
    };
  })();

  const yesterdaySnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'yesterday', yesterdayDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${yesterdayDate}`),
    staleTime: 5 * 60_000,
  });

  const dayBeforeSnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'dayBefore', dayBeforeDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${dayBeforeDate}`),
    staleTime: 5 * 60_000,
  });

  const yd = yesterdaySnapshot.data;
  const db = dayBeforeSnapshot.data;

  const deltaLabel = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return `${String(y.getMonth() + 1)}/${String(y.getDate())} vs ${String(d2.getMonth() + 1)}/${String(d2.getDate())}`;
  })();

  const isRange = fromDate !== toDate;
  const snapshotUrl = isRange
    ? `/v1/dashboard/snapshots?date=${fromDate}&to=${toDate}`
    : `/v1/dashboard/snapshots?date=${fromDate}`;

  const snapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', fromDate, toDate],
    queryFn: () => api.get<SnapshotData>(snapshotUrl),
    enabled: mode === 'historical' && fromDate !== '',
  });

  const trendQuery = useQuery({
    queryKey: ['dashboard', 'snapshots', 'trend'],
    queryFn: () => api.get<{ days: TrendDay[] }>('/v1/dashboard/snapshots/trend'),
    enabled: mode === 'trend',
  });

  const formatCurrency = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

  const formatCo2 = (kg: number): string =>
    kg >= 1000 ? `${(kg / 1000).toFixed(1)}\u00a0t` : `${kg.toFixed(1)}\u00a0kg`;

  function dateControl(range: ReturnType<typeof useDateRange>): React.JSX.Element {
    return (
      <DateRangeControl
        days={range.days}
        from={range.customFrom}
        to={range.customTo}
        onPresetChange={range.handlePreset}
        onCustomChange={range.handleCustom}
      />
    );
  }

  const formatEnergy = (wh: number): string =>
    wh >= 100_000_000
      ? `${(wh / 1_000_000).toFixed(1)}\u00a0MWh`
      : `${(wh / 1000).toFixed(1)}\u00a0kWh`;

  function renderLiveStatCards(): React.JSX.Element {
    return (
      <>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-5">
          <StatCard
            title={t('dashboard.totalStations')}
            value={stats.totalStations}
            info={t('dashboard.info.totalStations')}
            dayDelta={computeDelta(yd?.totalStations, db?.totalStations)}
            deltaLabel={deltaLabel}
            extra={<OnboardingStatusBadges counts={stats.onboardingStatusCounts} />}
          />
          <StatCard
            title={t('dashboard.online')}
            value={`${String(stats.onlinePercent)}%`}
            info={t('dashboard.info.online')}
            dayDelta={computeDelta(yd?.onlinePercent, db?.onlinePercent)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.uptime')}
            value={`${String(uptimeQuery.data?.uptimePercent ?? 100)}%`}
            info={t('dashboard.info.uptime')}
            dayDelta={computeDelta(yd?.uptimePercent, db?.uptimePercent)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={stats.activeSessions}
            info={t('dashboard.info.activeSessions')}
            dayDelta={computeDelta(yd?.activeSessions, db?.activeSessions)}
            deltaLabel={deltaLabel}
          />
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-1">
                {t('dashboard.co2Avoided')}
                <InfoTooltip
                  content={<div className="max-w-56">{t('dashboard.co2AvoidedTooltip')}</div>}
                />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg sm:text-2xl font-bold whitespace-nowrap text-success">
                {formatCo2(carbonStats.data?.totalCo2AvoidedKg ?? 0)}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-5">
          <StatCard
            title={t('dashboard.energyDelivered')}
            value={formatEnergy(stats.totalEnergyWh)}
            info={t('dashboard.info.energyDelivered')}
            dayDelta={computeDelta(yd?.totalEnergyWh, db?.totalEnergyWh)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.totalSessions')}
            value={stats.totalSessions}
            info={t('dashboard.info.totalSessions')}
            dayDelta={computeDelta(yd?.totalSessions, db?.totalSessions)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.ocppConnections')}
            value={ocppHealth.data?.connectedStations ?? 0}
            info={t('dashboard.info.ocppConnections')}
            dayDelta={computeDelta(yd?.connectedStations, db?.connectedStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.pingLatency')}
            value={`${String(ocppHealth.data?.avgPingLatencyMs ?? 0)}\u00a0ms`}
            info={t('dashboard.info.pingLatency')}
            positiveIsGood={false}
            dayDelta={computeDelta(yd?.avgPingLatencyMs, db?.avgPingLatencyMs)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.pingSuccessRate')}
            value={`${String(ocppHealth.data?.pingSuccessRate ?? 100)}%`}
            info={t('dashboard.info.pingSuccessRate')}
            dayDelta={computeDelta(yd?.pingSuccessRate, db?.pingSuccessRate)}
            deltaLabel={deltaLabel}
          />
        </div>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.totalRevenue')}
            value={formatCurrency(financialStats.data?.totalRevenueCents ?? 0)}
            info={t('dashboard.info.totalRevenue')}
            dayDelta={computeDelta(yd?.totalRevenueCents, db?.totalRevenueCents)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.todayRevenue')}
            value={formatCurrency(financialStats.data?.todayRevenueCents ?? 0)}
            info={t('dashboard.info.todayRevenue')}
            dayDelta={computeDelta(yd?.dayRevenueCents, db?.dayRevenueCents)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.revenuePerSession')}
            value={formatCurrency(financialStats.data?.avgRevenueCentsPerSession ?? 0)}
            info={t('dashboard.info.revenuePerSession')}
            dayDelta={computeDelta(yd?.avgRevenueCentsPerSession, db?.avgRevenueCentsPerSession)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.totalTransactions')}
            value={financialStats.data?.totalTransactions ?? 0}
            info={t('dashboard.info.totalTransactions')}
            dayDelta={computeDelta(yd?.totalTransactions, db?.totalTransactions)}
            deltaLabel={deltaLabel}
          />
        </div>
      </>
    );
  }

  function renderHistoricalStatCards(): React.JSX.Element {
    const s = snapshot.data;
    const hasData =
      !snapshot.isLoading &&
      fromDate !== '' &&
      s != null &&
      (s.totalStations > 0 || s.totalSessions > 0);

    if (!hasData) {
      const msg =
        fromDate === ''
          ? t('dashboard.selectDate')
          : snapshot.isLoading
            ? '...'
            : t('dashboard.noSnapshotData');
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    const d = isRange ? { date: `${fromDate} to ${toDate}` } : { date: fromDate };

    return (
      <>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.totalStations')}
            value={s.totalStations}
            info={t('dashboard.historicalInfo.totalStations', d)}
          />
          <StatCard
            title={t('dashboard.online')}
            value={`${String(Math.round(s.onlinePercent * 10) / 10)}%`}
            info={t('dashboard.historicalInfo.online', d)}
          />
          <StatCard
            title={t('dashboard.uptime')}
            value={`${String(s.uptimePercent)}%`}
            info={t('dashboard.historicalInfo.uptime', d)}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={s.activeSessions}
            info={t('dashboard.historicalInfo.activeSessions', d)}
          />
        </div>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.dayEnergy')}
            value={formatEnergy(s.dayEnergyWh)}
            info={t('dashboard.historicalInfo.dayEnergy', d)}
          />
          <StatCard
            title={t('dashboard.daySessions')}
            value={s.daySessions}
            info={t('dashboard.historicalInfo.daySessions', d)}
          />
          <StatCard
            title={t('dashboard.dayRevenue')}
            value={formatCurrency(s.dayRevenueCents)}
            info={t('dashboard.historicalInfo.dayRevenue', d)}
          />
          <StatCard
            title={t('dashboard.dayTransactions')}
            value={s.dayTransactions}
            info={t('dashboard.historicalInfo.dayTransactions', d)}
          />
        </div>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.totalRevenue')}
            value={formatCurrency(s.totalRevenueCents)}
            info={t('dashboard.historicalInfo.totalRevenue', d)}
          />
          <StatCard
            title={t('dashboard.revenuePerSession')}
            value={formatCurrency(s.avgRevenueCentsPerSession)}
            info={t('dashboard.historicalInfo.revenuePerSession', d)}
          />
          <StatCard
            title={t('dashboard.totalSessions')}
            value={s.totalSessions}
            info={t('dashboard.historicalInfo.totalSessions', d)}
          />
          <StatCard
            title={t('dashboard.totalTransactions')}
            value={s.totalTransactions}
            info={t('dashboard.historicalInfo.totalTransactions', d)}
          />
        </div>
      </>
    );
  }

  function renderTrendStatCards(): React.JSX.Element {
    const days = trendQuery.data?.days ?? [];
    const latest = days[0];

    if (trendQuery.isLoading || days.length < 2 || latest == null) {
      const msg = trendQuery.isLoading ? '...' : t('dashboard.notEnoughData');
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    const pluck = (key: keyof SnapshotData): number[] => days.map((d) => d[key]);
    const avg = (key: keyof SnapshotData): number => {
      const vals = pluck(key);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldest = days[days.length - 1];
    const newest = days[0];
    const tr = { from: oldest?.date ?? '', to: newest?.date ?? '' };

    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <TrendStatCard
          title={t('dashboard.totalStations')}
          value={Math.round(avg('totalStations'))}
          data={pluck('totalStations')}
          info={t('dashboard.trendInfo.totalStations', tr)}
        />
        <TrendStatCard
          title={t('dashboard.online')}
          value={`${String(Math.round(avg('onlinePercent') * 10) / 10)}%`}
          data={pluck('onlinePercent')}
          info={t('dashboard.trendInfo.online', tr)}
        />
        <TrendStatCard
          title={t('dashboard.uptime')}
          value={`${String(Math.round(avg('uptimePercent') * 10) / 10)}%`}
          data={pluck('uptimePercent')}
          info={t('dashboard.trendInfo.uptime', tr)}
        />
        <TrendStatCard
          title={t('dashboard.daySessions')}
          value={Math.round(avg('daySessions'))}
          data={pluck('daySessions')}
          info={t('dashboard.trendInfo.daySessions', tr)}
        />
        <TrendStatCard
          title={t('dashboard.dayRevenue')}
          value={formatCurrency(Math.round(avg('dayRevenueCents')))}
          data={pluck('dayRevenueCents')}
          info={t('dashboard.trendInfo.dayRevenue', tr)}
        />
        <TrendStatCard
          title={t('dashboard.dayEnergy')}
          value={formatEnergy(Math.round(avg('dayEnergyWh')))}
          data={pluck('dayEnergyWh')}
          info={t('dashboard.trendInfo.dayEnergy', tr)}
        />
        <TrendStatCard
          title={t('dashboard.revenuePerSession')}
          value={formatCurrency(Math.round(avg('avgRevenueCentsPerSession')))}
          data={pluck('avgRevenueCentsPerSession')}
          info={t('dashboard.trendInfo.revenuePerSession', tr)}
        />
        <TrendStatCard
          title={t('dashboard.totalSessions')}
          value={Math.round(avg('totalSessions'))}
          data={pluck('totalSessions')}
          info={t('dashboard.trendInfo.totalSessions', tr)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="relative">
        {mode !== 'live' && (
          <div className="invisible space-y-4" aria-hidden="true">
            {renderLiveStatCards()}
          </div>
        )}
        <div className={mode !== 'live' ? 'absolute inset-0 space-y-4' : 'space-y-4'}>
          {mode === 'live' && renderLiveStatCards()}
          {mode === 'historical' && renderHistoricalStatCards()}
          {mode === 'trend' && renderTrendStatCards()}
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <StationStatusChart
          data={stationStatus.data ?? []}
          info={t('dashboard.info.stationStatus')}
        />
        <UtilizationChart
          data={utilization.data ?? []}
          actions={dateControl(utilRange)}
          info={t('dashboard.info.utilization')}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <EnergyChart
          data={energyHistory.data ?? []}
          actions={dateControl(energy)}
          info={t('dashboard.info.energyChart')}
        />
        <SessionsChart
          data={sessionHistory.data ?? []}
          actions={dateControl(sessions)}
          info={t('dashboard.info.sessionsChart')}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <RevenueChart
          data={revenueHistory.data ?? []}
          actions={dateControl(revenue)}
          info={t('dashboard.info.revenueChart')}
        />
        <PaymentBreakdownChart
          data={paymentBreakdown.data ?? []}
          info={t('dashboard.info.paymentBreakdown')}
        />
      </div>

      <PeakUsageChart
        data={peakUsage.data ?? []}
        actions={dateControl(peak)}
        info={t('dashboard.info.peakUsage')}
      />

      <StationMapChart info={t('dashboard.info.siteMap')} />
    </>
  );
}

function OperatorDashboard({
  stats,
  mode,
  fromDate,
  toDate,
}: {
  stats: DashboardStats;
  mode: DashboardMode;
  fromDate: string;
  toDate: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const energyHistory = useQuery({
    queryKey: ['dashboard', 'energy-history', '1d'],
    queryFn: () => api.get<EnergyPoint[]>('/v1/dashboard/energy-history?days=1'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const stationStatus = useQuery({
    queryKey: ['dashboard', 'station-status'],
    queryFn: () => api.get<StatusPoint[]>('/v1/dashboard/station-status'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const { data: sessionsResponse, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions', 'active'],
    queryFn: () =>
      api.get<{ data: Session[]; total: number }>('/v1/sessions?limit=20&status=active'),
    refetchInterval: 30_000,
  });

  const isRange = fromDate !== toDate;
  const snapshotUrl = isRange
    ? `/v1/dashboard/snapshots?date=${fromDate}&to=${toDate}`
    : `/v1/dashboard/snapshots?date=${fromDate}`;

  const snapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', fromDate, toDate],
    queryFn: () => api.get<SnapshotData>(snapshotUrl),
    enabled: mode === 'historical' && fromDate !== '',
  });

  const trendQuery = useQuery({
    queryKey: ['dashboard', 'snapshots', 'trend'],
    queryFn: () => api.get<{ days: TrendDay[] }>('/v1/dashboard/snapshots/trend'),
    enabled: mode === 'trend',
  });

  const { yesterdayDate, dayBeforeDate } = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return {
      yesterdayDate: y.toISOString().split('T')[0] ?? '',
      dayBeforeDate: d2.toISOString().split('T')[0] ?? '',
    };
  })();

  const yesterdaySnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'yesterday', yesterdayDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${yesterdayDate}`),
    staleTime: 5 * 60_000,
  });

  const dayBeforeSnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'dayBefore', dayBeforeDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${dayBeforeDate}`),
    staleTime: 5 * 60_000,
  });

  const yd = yesterdaySnapshot.data;
  const db = dayBeforeSnapshot.data;

  const deltaLabel = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return `${String(y.getMonth() + 1)}/${String(y.getDate())} vs ${String(d2.getMonth() + 1)}/${String(d2.getDate())}`;
  })();

  function renderLiveStatCards(): React.JSX.Element {
    return (
      <>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.stations')}
            value={stats.totalStations}
            info={t('dashboard.info.totalStations')}
            dayDelta={computeDelta(yd?.totalStations, db?.totalStations)}
            deltaLabel={deltaLabel}
            extra={<OnboardingStatusBadges counts={stats.onboardingStatusCounts} />}
          />
          <StatCard
            title={t('dashboard.online')}
            value={stats.onlineStations}
            info={t('dashboard.info.onlineCount')}
            dayDelta={computeDelta(yd?.onlineStations, db?.onlineStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={stats.activeSessions}
            info={t('dashboard.info.activeSessions')}
            dayDelta={computeDelta(yd?.activeSessions, db?.activeSessions)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.faults')}
            value={stats.faultedStations}
            info={t('dashboard.info.faults')}
            positiveIsGood={false}
          />
        </div>
      </>
    );
  }

  function renderHistoricalStatCards(): React.JSX.Element {
    const s = snapshot.data;
    const hasData =
      !snapshot.isLoading &&
      fromDate !== '' &&
      s != null &&
      (s.totalStations > 0 || s.totalSessions > 0);

    if (!hasData) {
      const msg =
        fromDate === ''
          ? t('dashboard.selectDate')
          : snapshot.isLoading
            ? '...'
            : t('dashboard.noSnapshotData');
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    const d = isRange ? { date: `${fromDate} to ${toDate}` } : { date: fromDate };

    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.totalStations')}
          value={s.totalStations}
          info={t('dashboard.historicalInfo.totalStations', d)}
        />
        <StatCard
          title={t('dashboard.online')}
          value={s.onlineStations}
          info={t('dashboard.historicalInfo.onlineCount', d)}
        />
        <StatCard
          title={t('dashboard.activeSessions')}
          value={s.activeSessions}
          info={t('dashboard.historicalInfo.activeSessions', d)}
        />
        <StatCard
          title={t('dashboard.daySessions')}
          value={s.daySessions}
          info={t('dashboard.historicalInfo.daySessions', d)}
        />
      </div>
    );
  }

  function renderTrendStatCards(): React.JSX.Element {
    const days = trendQuery.data?.days ?? [];
    const latest = days[0];

    if (trendQuery.isLoading || days.length < 2 || latest == null) {
      const msg = trendQuery.isLoading ? '...' : t('dashboard.notEnoughData');
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    const pluck = (key: keyof SnapshotData): number[] => days.map((d) => d[key]);
    const avg = (key: keyof SnapshotData): number => {
      const vals = pluck(key);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldest = days[days.length - 1];
    const newest = days[0];
    const tr = { from: oldest?.date ?? '', to: newest?.date ?? '' };

    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <TrendStatCard
          title={t('dashboard.totalStations')}
          value={Math.round(avg('totalStations'))}
          data={pluck('totalStations')}
          info={t('dashboard.trendInfo.totalStations', tr)}
        />
        <TrendStatCard
          title={t('dashboard.online')}
          value={Math.round(avg('onlineStations'))}
          data={pluck('onlineStations')}
          info={t('dashboard.trendInfo.onlineCount', tr)}
        />
        <TrendStatCard
          title={t('dashboard.activeSessions')}
          value={Math.round(avg('activeSessions'))}
          data={pluck('activeSessions')}
          info={t('dashboard.trendInfo.activeSessions', tr)}
        />
        <TrendStatCard
          title={t('dashboard.daySessions')}
          value={Math.round(avg('daySessions'))}
          data={pluck('daySessions')}
          info={t('dashboard.trendInfo.daySessions', tr)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="relative">
        {mode !== 'live' && (
          <div className="invisible space-y-4" aria-hidden="true">
            {renderLiveStatCards()}
          </div>
        )}
        <div className={mode !== 'live' ? 'absolute inset-0 space-y-4' : 'space-y-4'}>
          {mode === 'live' && renderLiveStatCards()}
          {mode === 'historical' && renderHistoricalStatCards()}
          {mode === 'trend' && renderTrendStatCards()}
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <EnergyChart
          data={energyHistory.data ?? []}
          title={t('dashboard.energyLast24h')}
          info={t('dashboard.info.energyChart')}
        />
        <StationStatusChart
          data={stationStatus.data ?? []}
          info={t('dashboard.info.stationStatus')}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            {t('charts.activeSessions')}
            <InfoTooltip
              content={<div className="max-w-56">{t('dashboard.info.activeSessionsTable')}</div>}
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SessionsTable
            sessions={sessionsResponse?.data}
            page={1}
            totalPages={1}
            onPageChange={() => {}}
            timezone={timezone}
            isLoading={sessionsLoading}
            emptyMessage={t('charts.noActiveSessions')}
          />
        </CardContent>
      </Card>
    </>
  );
}

export function Dashboard(): React.JSX.Element {
  const { t } = useTranslation();
  const role = useAuth((s) => s.role);
  const [mode, setMode] = useState<DashboardMode>('live');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0] ?? '';
  const [fromDate, setFromDate] = useState(yesterdayStr);
  const [toDate, setToDate] = useState(yesterdayStr);

  const { data: stats } = useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: () => api.get<DashboardStats>('/v1/dashboard/stats'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const defaultStats: DashboardStats = {
    totalStations: 0,
    onlineStations: 0,
    onlinePercent: 0,
    activeSessions: 0,
    totalSessions: 0,
    totalEnergyWh: 0,
    faultedStations: 0,
    statusCounts: {},
    onboardingStatusCounts: {},
  };

  const isAdmin = role === 'admin' || role == null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold">{t('dashboard.title')}</h1>
        <ModeToggle
          mode={mode}
          onModeChange={setMode}
          fromDate={fromDate}
          toDate={toDate}
          onFromChange={setFromDate}
          onToChange={setToDate}
        />
      </div>
      {isAdmin ? (
        <AdminDashboard
          stats={stats ?? defaultStats}
          mode={mode}
          fromDate={fromDate}
          toDate={toDate}
        />
      ) : (
        <OperatorDashboard
          stats={stats ?? defaultStats}
          mode={mode}
          fromDate={fromDate}
          toDate={toDate}
        />
      )}
    </div>
  );
}
