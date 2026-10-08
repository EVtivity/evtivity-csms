// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, ArrowRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { localDateString } from '@/lib/date-range';
import { useUpdateCheck } from '@/hooks/use-update-check';
import { useDayDeltaContext, type SnapshotData } from '@/hooks/use-day-delta-context';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { formatCents, formatNumber, formatNumberUpTo } from '@/lib/formatting';
import { parseValue, formatParsedValue } from '@/lib/animated-value';

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

interface TrendDay extends SnapshotData {
  date: string;
}

/**
 * A stat value stays on one line (value and unit are joined by a no-break space), so its size
 * follows the card, not the viewport: the card content is a size container. Six cards per row
 * (xl) leave about 99 px of content at 1280 px and 114 px at 1366 px, where "359.6 MWh" needs
 * 91 px at text-base, 102 px at text-lg and 136 px at text-2xl.
 */
const STAT_VALUE_CLASS =
  'text-base @min-[6.5rem]:text-lg @min-[9rem]:text-2xl font-bold whitespace-nowrap';

/** Rows of six stat cards; three per row below xl, where six leave no room for the values. */
const SIX_CARD_GRID_CLASS = 'grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6';

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
  totalNetRevenueCents: number;
  todayNetRevenueCents: number;
  totalTaxCents: number;
  todayTaxCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
  totalElectricityCostCents: number;
  dayElectricityCostCents: number;
  totalProfitCents: number;
  dayProfitCents: number;
  /** Account sessions whose fleet invoice is not paid yet (not revenue). */
  billedOnAccountCents?: number;
  billedOnAccountCount?: number;
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
  sessionCount: number;
  avgCo2AvoidedKgPerSession: number;
}

function useAnimatedValue(value: string | number): string {
  const { i18n } = useTranslation();
  const parsed = parseValue(value, i18n.language);
  const { num } = parsed;
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

  return formatParsedValue(parsed, display, i18n.language);
}

function ScrollSnapRow({
  pages,
}: {
  pages: { id: string; content: React.ReactNode }[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (el == null) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  }

  function goTo(index: number): void {
    const el = scrollRef.current;
    if (el == null) return;
    el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  }

  return (
    <div className="space-y-2">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] scrollbar-none [&::-webkit-scrollbar]:hidden"
      >
        {pages.map((page) => (
          <div key={page.id} className="w-full shrink-0 snap-start">
            {page.content}
          </div>
        ))}
      </div>
      <div className="flex justify-center gap-1.5">
        {pages.map((page, index) => (
          <button
            key={page.id}
            type="button"
            aria-label={t('dashboard.showPage', { page: index + 1, total: pages.length })}
            onClick={() => {
              goTo(index);
            }}
            className={`h-1.5 rounded-full transition-all ${
              index === active ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/40'
            }`}
          />
        ))}
      </div>
    </div>
  );
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
        : `${isPositive ? '+' : ''}${formatNumberUpTo(delta, 1)}% (${deltaLabel ?? ''})`
      : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1">
          {title}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="@container">
        {/* The trend arrow wraps below the value when the card is too narrow. */}
        <div className={`${STAT_VALUE_CLASS} flex flex-wrap items-center gap-x-2`}>
          <span>{animated}</span>
          {delta != null && tooltipText != null && (
            <InfoTooltip
              content={<div className="whitespace-nowrap">{tooltipText}</div>}
              showOnMobile
            >
              <span
                className={`inline-flex items-center cursor-default ${
                  isZero
                    ? 'text-muted-foreground'
                    : isGood
                      ? 'text-success'
                      : isBad
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                }`}
              >
                {isPositive ? (
                  <ArrowUp className="h-4 w-4" />
                ) : isNegative ? (
                  <ArrowDown className="h-4 w-4" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </span>
            </InfoTooltip>
          )}
        </div>
        {extra != null && <div className="mt-1.5">{extra}</div>}
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
      <CardContent className="@container space-y-2">
        <div className={STAT_VALUE_CLASS}>{animated}</div>
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
            {formatNumberUpTo(delta, 1)}%
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
      <div className="pointer-events-none select-none blur-xs opacity-50">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="rounded-lg bg-card border border-border px-6 py-3 shadow-xs text-sm text-muted-foreground">
          {message}
        </div>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onModeChange,
  range,
}: {
  mode: DashboardMode;
  onModeChange: (m: DashboardMode) => void;
  range: ReturnType<typeof useDateRange>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const today = localDateString(new Date());
  // Bound the historical date picker to dates that actually have snapshots so
  // operators can't pick pre-history dates that would only render a "No Data"
  // overlay. The endpoint returns dates DESC, so [-1] is the oldest.
  const { data: availableDates } = useQuery({
    queryKey: ['dashboard', 'snapshots', 'available-dates'],
    queryFn: () => api.get<string[]>('/v1/dashboard/snapshots/available-dates'),
    staleTime: 5 * 60_000,
    enabled: mode === 'historical',
  });
  const oldestAvailable = availableDates?.[availableDates.length - 1] ?? '';

  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the date-range dropdown when clicking outside the toggle.
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: MouseEvent): void {
      if (containerRef.current != null && !containerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [pickerOpen]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <div className="inline-flex rounded-md border border-border">
        {(['live', 'trend', 'historical'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              onModeChange(m);
              // Entering historical opens the picker; clicking it again toggles.
              if (m === 'historical') {
                setPickerOpen((open) => (mode === 'historical' ? !open : true));
              } else {
                setPickerOpen(false);
              }
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
            {m === 'historical' && (
              <span className="inline-flex items-center gap-1.5">
                {t('dashboard.historical')}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    mode === 'historical' && pickerOpen ? 'rotate-180' : ''
                  }`}
                />
              </span>
            )}
            {m === 'trend' && t('dashboard.trend')}
          </button>
        ))}
      </div>
      {mode === 'historical' && pickerOpen && (
        <div className="absolute right-0 top-full z-20 mt-2 rounded-md border border-border bg-popover p-3 shadow-md animate-slide-in-from-top">
          <DateRangeControl
            days={range.days}
            from={range.customFrom}
            to={range.customTo}
            onPresetChange={range.handlePreset}
            onCustomChange={range.handleCustom}
            minDate={oldestAvailable || undefined}
            maxDate={today}
          />
        </div>
      )}
    </div>
  );
}

const REFETCH_INTERVAL = 60_000;

const MONEY_PLACEHOLDER = '-';

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

  const { yd, db, dayDelta, deltaLabel } = useDayDeltaContext();

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

  // Snapshot, trend, and revenue-history responses carry no currency, so they use the company one.
  const liveCurrency = financialStats.data?.currency;
  const company = useCompanyCurrency();
  const companyCurrency = company.currency;
  const currencyLoadFailed = financialStats.isError || company.isError;
  const formatMoney = (cents: number, currency: string | undefined): string =>
    currency != null ? formatCents(cents, currency) : MONEY_PLACEHOLDER;

  const formatCo2 = (kg: number): string =>
    kg >= 1000 ? `${formatNumber(kg / 1000, 1)}\u00a0t` : `${formatNumber(kg, 1)}\u00a0kg`;

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
      ? `${formatNumber(wh / 1_000_000, 1)}\u00a0MWh`
      : `${formatNumber(wh / 1000, 1)}\u00a0kWh`;

  function renderLiveStatCards(): React.JSX.Element {
    const revenueGrid = (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.totalRevenue')}
          value={formatMoney(financialStats.data?.totalRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.totalRevenue')}
          dayDelta={dayDelta(yd?.totalRevenueCents, db?.totalRevenueCents)}
          deltaLabel={deltaLabel}
        />
        <StatCard
          title={t('dashboard.todayRevenue')}
          value={formatMoney(financialStats.data?.todayRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayRevenue')}
          dayDelta={dayDelta(yd?.dayRevenueCents, db?.dayRevenueCents)}
          deltaLabel={deltaLabel}
        />
        <StatCard
          title={t('dashboard.revenuePerSession')}
          value={formatMoney(financialStats.data?.avgRevenueCentsPerSession ?? 0, liveCurrency)}
          info={t('dashboard.info.revenuePerSession')}
          dayDelta={dayDelta(yd?.avgRevenueCentsPerSession, db?.avgRevenueCentsPerSession)}
          deltaLabel={deltaLabel}
        />
        <StatCard
          title={t('dashboard.totalTransactions')}
          value={financialStats.data?.totalTransactions ?? 0}
          info={t('dashboard.info.totalTransactions')}
          dayDelta={dayDelta(yd?.totalTransactions, db?.totalTransactions)}
          deltaLabel={deltaLabel}
        />
      </div>
    );

    const taxGrid = (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.netRevenue')}
          value={formatMoney(financialStats.data?.totalNetRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.netRevenue')}
        />
        <StatCard
          title={t('dashboard.todayNetRevenue')}
          value={formatMoney(financialStats.data?.todayNetRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayNetRevenue')}
        />
        <StatCard
          title={t('dashboard.taxCollected')}
          value={formatMoney(financialStats.data?.totalTaxCents ?? 0, liveCurrency)}
          info={t('dashboard.info.taxCollected')}
        />
        <StatCard
          title={t('dashboard.todayTaxCollected')}
          value={formatMoney(financialStats.data?.todayTaxCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayTaxCollected')}
        />
      </div>
    );

    const costGrid = (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.electricityCost')}
          value={formatMoney(financialStats.data?.totalElectricityCostCents ?? 0, liveCurrency)}
          info={t('dashboard.info.electricityCost')}
        />
        <StatCard
          title={t('dashboard.dayElectricityCost')}
          value={formatMoney(financialStats.data?.dayElectricityCostCents ?? 0, liveCurrency)}
          info={t('dashboard.info.dayElectricityCost')}
        />
        <StatCard
          title={t('dashboard.profit')}
          value={formatMoney(financialStats.data?.totalProfitCents ?? 0, liveCurrency)}
          info={t('dashboard.info.profit')}
        />
        <StatCard
          title={t('dashboard.dayProfit')}
          value={formatMoney(financialStats.data?.dayProfitCents ?? 0, liveCurrency)}
          info={t('dashboard.info.dayProfit')}
        />
      </div>
    );

    // Charge on account: shown only when account sessions are waiting for
    // their fleet invoice to be paid.
    const billedOnAccountCount = financialStats.data?.billedOnAccountCount ?? 0;
    const accountGrid = (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.billedOnAccount')}
          value={formatMoney(financialStats.data?.billedOnAccountCents ?? 0, liveCurrency)}
          info={t('dashboard.info.billedOnAccount')}
        />
        <StatCard
          title={t('dashboard.billedOnAccountSessions')}
          value={billedOnAccountCount}
          info={t('dashboard.info.billedOnAccountSessions')}
        />
      </div>
    );

    return (
      <>
        <div className={SIX_CARD_GRID_CLASS}>
          <StatCard
            title={t('dashboard.totalStations')}
            value={stats.totalStations}
            info={t('dashboard.info.totalStations')}
            dayDelta={dayDelta(yd?.totalStations, db?.totalStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.online')}
            value={`${formatNumberUpTo(stats.onlinePercent, 1)}%`}
            info={t('dashboard.info.online')}
            dayDelta={dayDelta(yd?.onlinePercent, db?.onlinePercent)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.uptime')}
            value={`${formatNumberUpTo(uptimeQuery.data?.uptimePercent ?? 100, 2)}%`}
            info={t('dashboard.info.uptime')}
            dayDelta={dayDelta(yd?.uptimePercent, db?.uptimePercent)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={stats.activeSessions}
            info={t('dashboard.info.activeSessions')}
            dayDelta={dayDelta(yd?.activeSessions, db?.activeSessions)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.faults')}
            value={stats.faultedStations}
            info={t('dashboard.info.faults')}
            positiveIsGood={false}
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
            <CardContent className="@container">
              <div className={`${STAT_VALUE_CLASS} text-success`}>
                {formatCo2(carbonStats.data?.totalCo2AvoidedKg ?? 0)}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className={SIX_CARD_GRID_CLASS}>
          <StatCard
            title={t('dashboard.energyDelivered')}
            value={formatEnergy(stats.totalEnergyWh)}
            info={t('dashboard.info.energyDelivered')}
            dayDelta={dayDelta(yd?.totalEnergyWh, db?.totalEnergyWh)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.totalSessions')}
            value={stats.totalSessions}
            info={t('dashboard.info.totalSessions')}
            dayDelta={dayDelta(yd?.totalSessions, db?.totalSessions)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.ocppConnections')}
            value={ocppHealth.data?.connectedStations ?? 0}
            info={t('dashboard.info.ocppConnections')}
            dayDelta={dayDelta(yd?.connectedStations, db?.connectedStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.pingLatency')}
            value={`${formatNumberUpTo(ocppHealth.data?.avgPingLatencyMs ?? 0, 2)}\u00a0ms`}
            info={t('dashboard.info.pingLatency')}
            positiveIsGood={false}
            dayDelta={dayDelta(yd?.avgPingLatencyMs, db?.avgPingLatencyMs)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.pingSuccessRate')}
            value={`${formatNumberUpTo(ocppHealth.data?.pingSuccessRate ?? 100, 1)}%`}
            info={t('dashboard.info.pingSuccessRate')}
            dayDelta={dayDelta(yd?.pingSuccessRate, db?.pingSuccessRate)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.totalPorts')}
            value={uptimeQuery.data?.totalPorts ?? 0}
            info={t('dashboard.info.totalPorts')}
            dayDelta={dayDelta(yd?.totalPorts, db?.totalPorts)}
            deltaLabel={deltaLabel}
          />
        </div>

        <ScrollSnapRow
          pages={[
            { id: 'revenue', content: revenueGrid },
            { id: 'tax', content: taxGrid },
            { id: 'cost', content: costGrid },
            ...(billedOnAccountCount > 0 ? [{ id: 'account', content: accountGrid }] : []),
          ]}
        />
      </>
    );
  }

  function renderHistoricalStatCards(): React.JSX.Element {
    const s = snapshot.data;
    const hasData = !snapshot.isLoading && fromDate !== '' && s != null && s.hasData;

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
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.totalStations')}
            value={s.totalStations}
            info={t('dashboard.historicalInfo.totalStations', d)}
          />
          <StatCard
            title={t('dashboard.online')}
            value={`${formatNumberUpTo(s.onlinePercent, 1)}%`}
            info={t('dashboard.historicalInfo.online', d)}
          />
          <StatCard
            title={t('dashboard.uptime')}
            value={`${formatNumberUpTo(s.uptimePercent, 2)}%`}
            info={t('dashboard.historicalInfo.uptime', d)}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={s.activeSessions}
            info={t('dashboard.historicalInfo.activeSessions', d)}
          />
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
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
            value={formatMoney(s.dayRevenueCents, companyCurrency)}
            info={t('dashboard.historicalInfo.dayRevenue', d)}
          />
          <StatCard
            title={t('dashboard.dayTransactions')}
            value={s.dayTransactions}
            info={t('dashboard.historicalInfo.dayTransactions', d)}
          />
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.totalRevenue')}
            value={formatMoney(s.totalRevenueCents, companyCurrency)}
            info={t('dashboard.historicalInfo.totalRevenue', d)}
          />
          <StatCard
            title={t('dashboard.revenuePerSession')}
            value={formatMoney(s.avgRevenueCentsPerSession, companyCurrency)}
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

    type NumericSnapshotKey = Exclude<keyof SnapshotData, 'hasData'>;
    const pluck = (key: NumericSnapshotKey): number[] => days.map((d) => d[key]);
    const avg = (key: NumericSnapshotKey): number => {
      const vals = pluck(key);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldest = days[days.length - 1];
    const newest = days[0];
    const tr = { from: oldest?.date ?? '', to: newest?.date ?? '' };

    return (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <TrendStatCard
          title={t('dashboard.totalStations')}
          value={Math.round(avg('totalStations'))}
          data={pluck('totalStations')}
          info={t('dashboard.trendInfo.totalStations', tr)}
        />
        <TrendStatCard
          title={t('dashboard.online')}
          value={`${formatNumberUpTo(avg('onlinePercent'), 1)}%`}
          data={pluck('onlinePercent')}
          info={t('dashboard.trendInfo.online', tr)}
        />
        <TrendStatCard
          title={t('dashboard.uptime')}
          value={`${formatNumberUpTo(avg('uptimePercent'), 1)}%`}
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
          value={formatMoney(Math.round(avg('dayRevenueCents')), companyCurrency)}
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
          value={formatMoney(Math.round(avg('avgRevenueCentsPerSession')), companyCurrency)}
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
      {currencyLoadFailed && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">{t('common.loadError')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (financialStats.isError) void financialStats.refetch();
              if (company.isError) company.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      <div className="relative">
        {mode !== 'live' && (
          <div className="hidden lg:block invisible space-y-4" aria-hidden="true">
            {renderLiveStatCards()}
          </div>
        )}
        <div className={mode !== 'live' ? 'space-y-4 lg:absolute lg:inset-0' : 'space-y-4'}>
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
          currency={companyCurrency}
          currencyError={company.isError}
          onRetry={company.refetch}
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

  const { yd, db, dayDelta, deltaLabel } = useDayDeltaContext();

  function renderLiveStatCards(): React.JSX.Element {
    return (
      <>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.stations')}
            value={stats.totalStations}
            info={t('dashboard.info.totalStations')}
            dayDelta={dayDelta(yd?.totalStations, db?.totalStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.online')}
            value={stats.onlineStations}
            info={t('dashboard.info.onlineCount')}
            dayDelta={dayDelta(yd?.onlineStations, db?.onlineStations)}
            deltaLabel={deltaLabel}
          />
          <StatCard
            title={t('dashboard.activeSessions')}
            value={stats.activeSessions}
            info={t('dashboard.info.activeSessions')}
            dayDelta={dayDelta(yd?.activeSessions, db?.activeSessions)}
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
    const hasData = !snapshot.isLoading && fromDate !== '' && s != null && s.hasData;

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
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
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

    type NumericSnapshotKey = Exclude<keyof SnapshotData, 'hasData'>;
    const pluck = (key: NumericSnapshotKey): number[] => days.map((d) => d[key]);
    const avg = (key: NumericSnapshotKey): number => {
      const vals = pluck(key);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldest = days[days.length - 1];
    const newest = days[0];
    const tr = { from: oldest?.date ?? '', to: newest?.date ?? '' };

    return (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
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
          <div className="hidden lg:block invisible space-y-4" aria-hidden="true">
            {renderLiveStatCards()}
          </div>
        )}
        <div className={mode !== 'live' ? 'space-y-4 lg:absolute lg:inset-0' : 'space-y-4'}>
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
  useUpdateCheck();
  const [mode, setMode] = useState<DashboardMode>('live');
  const historical = useDateRange();

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
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('dashboard.title')}</h1>
        <ModeToggle mode={mode} onModeChange={setMode} range={historical} />
      </div>
      {isAdmin ? (
        <AdminDashboard
          stats={stats ?? defaultStats}
          mode={mode}
          fromDate={historical.effectiveFrom}
          toDate={historical.effectiveTo}
        />
      ) : (
        <OperatorDashboard
          stats={stats ?? defaultStats}
          mode={mode}
          fromDate={historical.effectiveFrom}
          toDate={historical.effectiveTo}
        />
      )}
    </div>
  );
}
