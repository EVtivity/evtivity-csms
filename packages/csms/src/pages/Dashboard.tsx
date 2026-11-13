// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Children, Fragment, isValidElement, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, ArrowRight, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { LoadingLogo } from '@/components/loading-logo';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { EnergyChart } from '@/components/charts/EnergyChart';
import { SessionsChart } from '@/components/charts/SessionsChart';
import { Sparkline } from '@/components/charts/Sparkline';
import { SecurityEventsCard } from '@/components/charts/SecurityEventsCard';
import { StationStatusChart } from '@/components/charts/StationStatusChart';
import { UtilizationChart } from '@/components/charts/UtilizationChart';
import { PeakUsageChart } from '@/components/charts/PeakUsageChart';
import { StationMapChart } from '@/components/charts/StationMapChart';
import { RevenueChart } from '@/components/charts/RevenueChart';
import { ALL_SESSIONS_SORT_KEYS, SessionsTable } from '@/components/SessionsTable';
import { Pagination } from '@/components/ui/pagination';
import { ScrollSnapRow } from '@/components/ui/scroll-snap-row';
import type { Session, SessionSortKey } from '@/components/SessionsTable';
import { useUserTimezone } from '@/lib/timezone';
import { PaymentBreakdownChart } from '@/components/charts/PaymentBreakdownChart';
import { LoadErrorRetry, queryState, type QueryState } from '@/components/charts/ChartBody';
import { DateRangeControl } from '@/components/DateRangeControl';
import { useDateRange } from '@/hooks/useDateRange';
import { localDateString } from '@/lib/date-range';
import { useUpdateCheck } from '@/hooks/use-update-check';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';
import { ActiveInsightsWidget } from '@/components/ai/insights/ActiveInsightsWidget';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useDashboardLayout } from '@/hooks/use-dashboard-layout';
import { SortableZone } from '@/components/dashboard/SortableZone';
import { SortableWidget } from '@/components/dashboard/SortableWidget';
import { SiteLayoutWidget } from '@/components/dashboard/SiteLayoutWidget';
import {
  DashboardCustomizeBar,
  DashboardCustomizeButton,
} from '@/components/dashboard/DashboardCustomizeBar';
import {
  LocationsByCityChart,
  type LocationsByCityData,
} from '@/components/charts/LocationsByCityChart';
import {
  EvsesByConnectorTypeChart,
  type EvsesByConnectorTypePoint,
} from '@/components/charts/EvsesByConnectorTypeChart';
import { PlugAndChargeChart, type PlugAndChargeData } from '@/components/charts/PlugAndChargeChart';
import { FreeVendChart, type FreeVendData } from '@/components/charts/FreeVendChart';
import { arrayMove } from '@dnd-kit/sortable';
import {
  dashboardWidget,
  defaultDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutItem,
} from '@evtivity/lib/dashboard-layout';
import { useDayDeltaContext, type SnapshotData } from '@/hooks/use-day-delta-context';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { formatCalendarDate, formatCents, formatNumber, formatNumberUpTo } from '@/lib/formatting';
import { parseValue, formatParsedValue } from '@/lib/animated-value';

interface DashboardStats {
  totalStations: number;
  onlineStations: number;
  onlinePercent: number;
  activeSessions: number;
  totalSessions: number;
  totalEnergyWh: number;
  faultedStations: number;
  /** Physical chargers: units of stations with units, 1 per station without. */
  chargingUnits?: number;
  /** A station of the user's sites has units: only then the Charging Units card shows. */
  hasStationUnits?: boolean;
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

/** The most columns a stat row may use from each breakpoint up: values need room. */
const STAT_GRID_MAX_COLUMNS = [
  ['', 2],
  ['md:', 3],
  ['lg:', 4],
  ['xl:', 6],
] as const;

/** Full class names, so Tailwind finds every one in the source. */
const GRID_COLS: Record<string, Record<number, string>> = {
  '': { 1: 'grid-cols-1', 2: 'grid-cols-2' },
  'md:': { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3' },
  'lg:': { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' },
  'xl:': {
    1: 'xl:grid-cols-1',
    2: 'xl:grid-cols-2',
    3: 'xl:grid-cols-3',
    4: 'xl:grid-cols-4',
    5: 'xl:grid-cols-5',
    6: 'xl:grid-cols-6',
  },
};

/**
 * The columns of a stat row at each breakpoint. From md up: the most that
 * divide the card count, so every row is full. On phones: two columns side by
 * side, 50/50 (one for a single card); an odd last card spans the row
 * (`STAT_GRID_PHONE_LAST_SPAN`), so no card sits at half width next to an
 * empty cell (owner decision 2026-11-13).
 */
export function statGridColumns(count: number): number[] {
  const n = Math.max(1, count);
  return STAT_GRID_MAX_COLUMNS.map(([prefix, max]) => {
    if (prefix === '') return Math.min(max, n);
    let cols = Math.min(max, n);
    while (n % cols !== 0) cols -= 1;
    return cols;
  });
}

/** On phones an odd last card takes the whole row; from md the row divides evenly again. */
const STAT_GRID_PHONE_LAST_SPAN = '[&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1';

/** Grid classes of a stat row by its card count (`statGridColumns`). */
export function statGridClass(count: number): string {
  const classes = ['grid', 'gap-4'];
  let previous = 0;
  const columns = statGridColumns(count);
  columns.forEach((cols, i) => {
    const prefix = STAT_GRID_MAX_COLUMNS[i]?.[0] ?? '';
    if (cols !== previous) classes.push(GRID_COLS[prefix]?.[cols] ?? '');
    previous = cols;
  });
  if (columns[0] === 2 && count % 2 === 1) classes.push(STAT_GRID_PHONE_LAST_SPAN);
  return classes.join(' ');
}

/** The cards a row renders: a fragment around some of them counts each card, not one. */
export function statCardCount(children: React.ReactNode): number {
  return Children.toArray(children).reduce<number>((count, child) => {
    if (isValidElement<{ children?: React.ReactNode }>(child) && child.type === Fragment) {
      return count + statCardCount(child.props.children);
    }
    return count + 1;
  }, 0);
}

/** A row of stat cards laid out by `statGridClass` (every dashboard stat row). */
function StatGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className={statGridClass(statCardCount(children))}>{children}</div>;
}

type DashboardMode = 'live' | 'historical' | 'trend';

/** The default layout, which the Historical and Trend views always use. */
const DEFAULT_LAYOUT = defaultDashboardLayout();

/** The chart grid: one column on phones, two from lg; a full-width chart spans both. */
const CHART_GRID_CLASS = 'grid gap-4 grid-cols-1 lg:grid-cols-2';

/** One widget of the Live view: its name, whether the user may see it, and its content. */
interface DashboardWidgetView {
  name: string;
  visible: boolean;
  render: () => React.ReactNode;
}

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
  /** Running OCPP server processes; the stats above are their fleet totals. */
  instanceCount: number;
  instances?: Array<{ instanceId: string; connectedStations: number }>;
}

interface CarbonStats {
  totalCo2AvoidedKg: number;
  sessionCount: number;
  avgCo2AvoidedKgPerSession: number;
}

/** The uptime card covers the last 30 days, as its label says. */
const UPTIME_DAYS = 30;

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

function StatCard({
  title,
  value,
  info,
  dayDelta,
  deltaLabel,
  positiveIsGood = true,
  extra,
  state,
  valueClassName,
}: {
  title: string;
  value: string | number;
  info?: string;
  dayDelta?: number | null | undefined;
  deltaLabel?: string | undefined;
  positiveIsGood?: boolean | undefined;
  extra?: React.ReactNode;
  /** The query behind the value: its loading mark or load error replace the value. */
  state?: QueryState | undefined;
  valueClassName?: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const animated = useAnimatedValue(value);

  const delta = dayDelta ?? null;
  const isPositive = delta != null && delta > 0;
  const isNegative = delta != null && delta < 0;
  const isZero = delta != null && delta === 0;
  const isGood = positiveIsGood ? isPositive : isNegative;
  const isBad = positiveIsGood ? isNegative : isPositive;

  const range = deltaLabel ?? '';
  const tooltipText =
    delta != null
      ? isZero
        ? t('dashboard.deltaNoChange', { range })
        : t('dashboard.deltaChange', {
            value: `${isPositive ? '+' : ''}${formatNumberUpTo(delta, 1)}`,
            range,
          })
      : null;

  return (
    <Card>
      <CardHeader variant="stat">
        <CardTitle variant="stat">
          {title}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="@container">
        {state?.isLoading === true ? (
          <LoadingLogo size="inline" />
        ) : state?.isError === true ? (
          <LoadErrorRetry onRetry={state.onRetry} />
        ) : (
          <>
            {/* The trend arrow wraps below the value when the card is too narrow. */}
            <div className={`${STAT_VALUE_CLASS} flex flex-wrap items-center gap-x-2`}>
              <span className={valueClassName}>{animated}</span>
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
          </>
        )}
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
      <CardHeader variant="stat">
        <CardTitle variant="stat">
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
  message: React.ReactNode;
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
            className={`h-10 px-3 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md ${
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
const ACTIVE_SESSIONS_PAGE_SIZE = 20;

const MONEY_PLACEHOLDER = '-';

/** A snapshot money field: null for a user without payments:read. */
function money(value: number | null): number {
  return value ?? 0;
}

/**
 * The dashboard. Every user gets the same one; a row shows only to users
 * with the permission its data needs: the money row (revenue, tax, cost,
 * profit, payments) needs payments:read, which the API checks too.
 */
function DashboardBody({
  mode,
  editing,
  fromDate,
  toDate,
}: {
  mode: DashboardMode;
  /** The Live view is being customized. */
  editing: boolean;
  fromDate: string;
  toDate: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The OCPP server ping statistics cover every site: all-site users only.
  const hasAllSiteAccess = useHasAllSiteAccess();
  const canSeeMoney = useHasPermission('payments:read');
  const canSeeSessions = useHasPermission('sessions:read');
  const canReadInsights = useHasPermission('aiInsights:read');
  // The site Layout tab reads with sites:read.
  const canReadSites = useHasPermission('sites:read');
  const canReadSecurityEvents = useHasPermission('securityEvents:read');
  const featureFlags = useFeatureFlags();
  const timezone = useUserTimezone();
  const dashboardLayout = useDashboardLayout();
  // A chart the Live layout shows; the four new charts fetch only then.
  const isChartShown = (id: string): boolean =>
    mode === 'live' &&
    dashboardLayout.layout?.charts.some((c) => c.id === id && !c.hidden) === true;

  const energy = useDateRange();
  const sessions = useDateRange();
  const utilRange = useDateRange();
  const peak = useDateRange();
  const revenue = useDateRange();
  const pncRange = useDateRange();
  const freeVendRange = useDateRange();

  const statsQuery = useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: () => api.get<DashboardStats>('/v1/dashboard/stats'),
    refetchInterval: REFETCH_INTERVAL,
  });

  const uptimeQuery = useQuery({
    queryKey: ['dashboard', 'uptime', UPTIME_DAYS],
    queryFn: () => api.get<UptimeStats>(`/v1/dashboard/uptime?days=${String(UPTIME_DAYS)}`),
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
    enabled: canSeeMoney,
  });

  const revenueHistory = useQuery({
    queryKey: ['dashboard', 'revenue-history', revenue.dateQuery],
    queryFn: () => api.get<RevenuePoint[]>(`/v1/dashboard/revenue-history?${revenue.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
    enabled: canSeeMoney,
  });

  const paymentBreakdown = useQuery({
    queryKey: ['dashboard', 'payment-breakdown'],
    queryFn: () => api.get<PaymentBreakdownPoint[]>('/v1/dashboard/payment-breakdown'),
    refetchInterval: REFETCH_INTERVAL,
    enabled: canSeeMoney,
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

  const locationsByCity = useQuery({
    queryKey: ['dashboard', 'locations-by-city'],
    queryFn: () => api.get<LocationsByCityData>('/v1/dashboard/locations-by-city'),
    refetchInterval: REFETCH_INTERVAL,
    enabled: isChartShown('chart.locationsByCity'),
  });

  const evsesByConnectorType = useQuery({
    queryKey: ['dashboard', 'evses-by-connector-type'],
    queryFn: () => api.get<EvsesByConnectorTypePoint[]>('/v1/dashboard/evses-by-connector-type'),
    refetchInterval: REFETCH_INTERVAL,
    enabled: isChartShown('chart.evsesByConnectorType'),
  });

  const plugAndCharge = useQuery({
    queryKey: ['dashboard', 'plug-and-charge', pncRange.dateQuery],
    queryFn: () =>
      api.get<PlugAndChargeData>(`/v1/dashboard/plug-and-charge?${pncRange.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
    enabled: isChartShown('chart.plugAndCharge'),
  });

  const freeVend = useQuery({
    queryKey: ['dashboard', 'free-vend', freeVendRange.dateQuery],
    queryFn: () => api.get<FreeVendData>(`/v1/dashboard/free-vend?${freeVendRange.dateQuery}`),
    refetchInterval: REFETCH_INTERVAL,
    enabled: isChartShown('chart.freeVend'),
  });

  const [activeSessionsPage, setActiveSessionsPage] = useState(1);
  const activeSessionsSort = useListSort<SessionSortKey>(ALL_SESSIONS_SORT_KEYS);
  // A new sort starts again at page 1.
  const activeSessionsTableSort: ListSort<SessionSortKey> = {
    ...activeSessionsSort,
    toggle: (key) => {
      setActiveSessionsPage(1);
      activeSessionsSort.toggle(key);
    },
  };
  const activeSessions = useQuery({
    queryKey: ['sessions', 'active', activeSessionsPage, activeSessionsSort.params],
    queryFn: () =>
      api.get<{ data: Session[]; total: number }>(
        `/v1/sessions?${new URLSearchParams({
          page: String(activeSessionsPage),
          limit: String(ACTIVE_SESSIONS_PAGE_SIZE),
          status: 'active',
          ...activeSessionsSort.params,
        }).toString()}`,
      ),
    refetchInterval: 30_000,
    enabled: canSeeSessions,
    // Keeps the current rows on screen while the next page loads.
    placeholderData: (previous) => previous,
  });
  const activeSessionsTotalPages = Math.max(
    1,
    Math.ceil((activeSessions.data?.total ?? 0) / ACTIVE_SESSIONS_PAGE_SIZE),
  );
  // Sessions end while the card is open: step back when the page runs past the end.
  useEffect(() => {
    if (activeSessionsPage > activeSessionsTotalPages) {
      setActiveSessionsPage(activeSessionsTotalPages);
    }
  }, [activeSessionsPage, activeSessionsTotalPages]);

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

  const stats = statsQuery.data;
  const statsState = queryState(statsQuery);
  const uptimeState = queryState(uptimeQuery);
  const ocppState = queryState(ocppHealth);
  const carbonState = queryState(carbonStats);
  // Money cards wait for the stats and for the company currency they are shown in.
  const financialState: QueryState = {
    isLoading: financialStats.isLoading,
    isError: financialStats.isError,
    onRetry: () => {
      void financialStats.refetch();
    },
  };
  const uptime = uptimeQuery.data;
  const fin = financialStats.data;

  // Pending and blocked stations are not in the counts; a note names them.
  const notAccepted = {
    pending: stats?.onboardingStatusCounts['pending'] ?? 0,
    blocked: stats?.onboardingStatusCounts['blocked'] ?? 0,
  };
  const stationsNote =
    notAccepted.pending + notAccepted.blocked > 0 ? (
      <p className="text-xs text-muted-foreground">
        {t('dashboard.stationsNotAccepted', notAccepted)}
      </p>
    ) : undefined;

  function renderLiveStatCards(): React.JSX.Element {
    const revenueGrid = (
      <StatGrid>
        <StatCard
          title={t('dashboard.totalRevenue')}
          value={formatMoney(fin?.totalRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.totalRevenue')}
          dayDelta={dayDelta(yd?.totalRevenueCents, db?.totalRevenueCents)}
          deltaLabel={deltaLabel}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.todayRevenue')}
          value={formatMoney(fin?.todayRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayRevenue')}
          dayDelta={dayDelta(yd?.dayRevenueCents, db?.dayRevenueCents)}
          deltaLabel={deltaLabel}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.revenuePerSession')}
          value={formatMoney(fin?.avgRevenueCentsPerSession ?? 0, liveCurrency)}
          info={t('dashboard.info.revenuePerSession')}
          dayDelta={dayDelta(yd?.avgRevenueCentsPerSession, db?.avgRevenueCentsPerSession)}
          deltaLabel={deltaLabel}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.totalTransactions')}
          value={fin?.totalTransactions ?? 0}
          info={t('dashboard.info.totalTransactions')}
          dayDelta={dayDelta(yd?.totalTransactions, db?.totalTransactions)}
          deltaLabel={deltaLabel}
          state={financialState}
        />
      </StatGrid>
    );

    const taxGrid = (
      <StatGrid>
        <StatCard
          title={t('dashboard.netRevenue')}
          value={formatMoney(fin?.totalNetRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.netRevenue')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.todayNetRevenue')}
          value={formatMoney(fin?.todayNetRevenueCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayNetRevenue')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.taxCollected')}
          value={formatMoney(fin?.totalTaxCents ?? 0, liveCurrency)}
          info={t('dashboard.info.taxCollected')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.todayTaxCollected')}
          value={formatMoney(fin?.todayTaxCents ?? 0, liveCurrency)}
          info={t('dashboard.info.todayTaxCollected')}
          state={financialState}
        />
      </StatGrid>
    );

    const costGrid = (
      <StatGrid>
        <StatCard
          title={t('dashboard.electricityCost')}
          value={formatMoney(fin?.totalElectricityCostCents ?? 0, liveCurrency)}
          info={t('dashboard.info.electricityCost')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.dayElectricityCost')}
          value={formatMoney(fin?.dayElectricityCostCents ?? 0, liveCurrency)}
          info={t('dashboard.info.dayElectricityCost')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.profit')}
          value={formatMoney(fin?.totalProfitCents ?? 0, liveCurrency)}
          info={t('dashboard.info.profit')}
          state={financialState}
        />
        <StatCard
          title={t('dashboard.dayProfit')}
          value={formatMoney(fin?.dayProfitCents ?? 0, liveCurrency)}
          info={t('dashboard.info.dayProfit')}
          state={financialState}
        />
      </StatGrid>
    );

    // Charge on account: shown only when account sessions are waiting for
    // their fleet invoice to be paid.
    const billedOnAccountCount = fin?.billedOnAccountCount ?? 0;
    const accountGrid = (
      <StatGrid>
        <StatCard
          title={t('dashboard.billedOnAccount')}
          value={formatMoney(fin?.billedOnAccountCents ?? 0, liveCurrency)}
          info={t('dashboard.info.billedOnAccount')}
        />
        <StatCard
          title={t('dashboard.billedOnAccountSessions')}
          value={billedOnAccountCount}
          info={t('dashboard.info.billedOnAccountSessions')}
        />
      </StatGrid>
    );

    const totalStationsCard = (
      <StatCard
        title={t('dashboard.totalStations')}
        value={stats?.totalStations ?? 0}
        info={t('dashboard.info.totalStations')}
        dayDelta={dayDelta(yd?.totalStations, db?.totalStations)}
        deltaLabel={deltaLabel}
        state={statsState}
        extra={stationsNote}
      />
    );
    // Physical chargers (a station's units, or the station itself without
    // units): computed live, so it has no day-over-day arrow.
    const chargingUnitsCard = (
      <StatCard
        title={t('dashboard.chargingUnits')}
        value={stats?.chargingUnits ?? 0}
        info={t('dashboard.info.chargingUnits')}
        state={statsState}
      />
    );
    const totalPortsCard = (
      <StatCard
        title={t('dashboard.totalPorts')}
        value={uptime?.totalPorts ?? 0}
        info={t('dashboard.info.totalPorts')}
        dayDelta={dayDelta(yd?.totalPorts, db?.totalPorts)}
        deltaLabel={deltaLabel}
        state={uptimeState}
      />
    );
    const onlineCard = (
      <StatCard
        title={t('dashboard.online')}
        value={`${formatNumberUpTo(stats?.onlinePercent ?? 0, 1)}%`}
        info={t('dashboard.info.online')}
        dayDelta={dayDelta(yd?.onlinePercent, db?.onlinePercent)}
        deltaLabel={deltaLabel}
        state={statsState}
      />
    );
    const uptimeCard = (
      <StatCard
        title={t('dashboard.uptime')}
        value={
          uptime == null || uptime.totalPorts === 0
            ? t('common.na')
            : `${formatNumberUpTo(uptime.uptimePercent, 2)}%`
        }
        info={t('dashboard.info.uptime')}
        dayDelta={dayDelta(yd?.uptimePercent, db?.uptimePercent)}
        deltaLabel={deltaLabel}
        state={uptimeState}
      />
    );
    const activeSessionsCard = (
      <StatCard
        title={t('dashboard.activeSessions')}
        value={stats?.activeSessions ?? 0}
        info={t('dashboard.info.activeSessions')}
        dayDelta={dayDelta(yd?.activeSessions, db?.activeSessions)}
        deltaLabel={deltaLabel}
        state={statsState}
      />
    );
    const faultsCard = (
      <StatCard
        title={t('dashboard.faults')}
        value={stats?.faultedStations ?? 0}
        info={t('dashboard.info.faults')}
        positiveIsGood={false}
        state={statsState}
      />
    );
    const co2Card = (
      <StatCard
        title={t('dashboard.co2Avoided')}
        value={formatCo2(carbonStats.data?.totalCo2AvoidedKg ?? 0)}
        info={t('dashboard.co2AvoidedTooltip')}
        state={carbonState}
        valueClassName="text-success"
      />
    );
    const energyCard = (
      <StatCard
        title={t('dashboard.energyDelivered')}
        value={formatEnergy(stats?.totalEnergyWh ?? 0)}
        info={t('dashboard.info.energyDelivered')}
        dayDelta={dayDelta(yd?.totalEnergyWh, db?.totalEnergyWh)}
        deltaLabel={deltaLabel}
        state={statsState}
      />
    );
    const totalSessionsCard = (
      <StatCard
        title={t('dashboard.totalSessions')}
        value={stats?.totalSessions ?? 0}
        info={t('dashboard.info.totalSessions')}
        dayDelta={dayDelta(yd?.totalSessions, db?.totalSessions)}
        deltaLabel={deltaLabel}
        state={statsState}
      />
    );
    const ocppCard = (
      <StatCard
        title={t('dashboard.ocppConnections')}
        value={ocppHealth.data?.connectedStations ?? 0}
        info={t('dashboard.info.ocppConnections')}
        dayDelta={dayDelta(yd?.connectedStations, db?.connectedStations)}
        deltaLabel={deltaLabel}
        state={ocppState}
        extra={
          (ocppHealth.data?.instanceCount ?? 0) > 1 ? (
            <p
              className="text-xs text-muted-foreground"
              title={ocppHealth.data?.instances
                ?.map((i) => `${i.instanceId}: ${String(i.connectedStations)}`)
                .join('\n')}
            >
              {t('dashboard.ocppServers', { count: ocppHealth.data?.instanceCount ?? 0 })}
            </p>
          ) : undefined
        }
      />
    );

    const pingLatencyCard = (
      <StatCard
        title={t('dashboard.pingLatency')}
        value={`${formatNumberUpTo(ocppHealth.data?.avgPingLatencyMs ?? 0, 2)}\u00a0ms`}
        info={t('dashboard.info.pingLatency')}
        positiveIsGood={false}
        dayDelta={dayDelta(yd?.avgPingLatencyMs, db?.avgPingLatencyMs)}
        deltaLabel={deltaLabel}
        state={ocppState}
      />
    );
    const pingSuccessCard = (
      <StatCard
        title={t('dashboard.pingSuccessRate')}
        value={`${formatNumberUpTo(ocppHealth.data?.pingSuccessRate ?? 0, 1)}%`}
        info={t('dashboard.info.pingSuccessRate')}
        dayDelta={dayDelta(yd?.pingSuccessRate, db?.pingSuccessRate)}
        deltaLabel={deltaLabel}
        state={ocppState}
      />
    );

    // Without station units the two rows of six stay as they were; Charging
    // Units shows only while a station of the user's sites has units.
    const healthRows =
      stats?.hasStationUnits !== true ? (
        <>
          <StatGrid>
            {totalStationsCard}
            {onlineCard}
            {uptimeCard}
            {activeSessionsCard}
            {faultsCard}
            {co2Card}
          </StatGrid>

          {/* The ping cards cover every site: a site-restricted user's row holds four. */}
          <StatGrid>
            {energyCard}
            {totalSessionsCard}
            {ocppCard}
            {hasAllSiteAccess && (
              <>
                {pingLatencyCard}
                {pingSuccessCard}
              </>
            )}
            {totalPortsCard}
          </StatGrid>
        </>
      ) : (
        <>
          {/* The counts first: stations, their physical chargers, their ports. */}
          <StatGrid>
            {totalStationsCard}
            {chargingUnitsCard}
            {totalPortsCard}
            {onlineCard}
            {uptimeCard}
            {activeSessionsCard}
          </StatGrid>

          {/*
            The ping cards cover every site, so a site-restricted user gets 11
            cards in all: rows of 6, 3 and 2 instead of 6, 4 and 3, every row full.
          */}
          {hasAllSiteAccess ? (
            <>
              <StatGrid>
                {faultsCard}
                {co2Card}
                {energyCard}
                {totalSessionsCard}
              </StatGrid>
              <StatGrid>
                {ocppCard}
                {pingLatencyCard}
                {pingSuccessCard}
              </StatGrid>
            </>
          ) : (
            <>
              <StatGrid>
                {faultsCard}
                {co2Card}
                {energyCard}
              </StatGrid>
              <StatGrid>
                {totalSessionsCard}
                {ocppCard}
              </StatGrid>
            </>
          )}
        </>
      );

    return (
      <>
        {healthRows}

        {canSeeMoney && (
          <ScrollSnapRow
            items={[
              { id: 'revenue', content: revenueGrid },
              { id: 'tax', content: taxGrid },
              { id: 'cost', content: costGrid },
              ...(billedOnAccountCount > 0 ? [{ id: 'account', content: accountGrid }] : []),
            ]}
            gap="gap-4"
          />
        )}
      </>
    );
  }

  /** The layout to render: the user's in the Live view, the default in the others. */
  const layout: DashboardLayout | null = mode === 'live' ? dashboardLayout.layout : DEFAULT_LAYOUT;

  function moveChart(activeId: string, overId: string): void {
    if (dashboardLayout.layout == null) return;
    const items = dashboardLayout.layout.charts;
    const from = items.findIndex((i) => i.id === activeId);
    const to = items.findIndex((i) => i.id === overId);
    if (from === -1 || to === -1) return;
    dashboardLayout.save({ ...dashboardLayout.layout, charts: arrayMove(items, from, to) });
  }

  /** The user's Site Layout item (its site), in every mode. */
  const siteLayoutItem = dashboardLayout.layout?.charts.find(
    (c) => c.id === 'chart.siteLayout3d',
  ) as (DashboardLayoutItem & { siteUnavailable?: boolean }) | undefined;

  function setLayoutSite(siteId: string): void {
    const current = dashboardLayout.layout;
    if (current == null) return;
    dashboardLayout.save({
      ...current,
      charts: current.charts.map((i) =>
        i.id === 'chart.siteLayout3d' ? { id: i.id, hidden: i.hidden, siteId } : i,
      ),
    });
  }

  function setChartHidden(id: string, hidden: boolean): void {
    const current = dashboardLayout.layout;
    if (current == null) return;
    dashboardLayout.save({
      ...current,
      charts: current.charts.map((i) => (i.id === id ? { ...i, hidden } : i)),
    });
  }

  /** The charts: the shown ones in layout order, sortable while editing. */
  function renderCharts(
    items: DashboardLayoutItem[],
    widgets: Record<string, DashboardWidgetView>,
    editable: boolean,
  ): React.JSX.Element {
    const shown = items.filter((i) => !i.hidden && widgets[i.id]?.visible === true);
    const names = Object.fromEntries(shown.map((i) => [i.id, widgets[i.id]?.name ?? i.id]));
    return (
      <SortableZone
        ids={shown.map((i) => i.id)}
        names={names}
        editing={editable}
        onMove={moveChart}
      >
        <div className={CHART_GRID_CLASS} data-testid="dashboard-charts">
          {shown.map((item) => (
            <SortableWidget
              key={item.id}
              id={item.id}
              name={names[item.id] ?? item.id}
              editing={editable}
              className={dashboardWidget(item.id)?.span === 'full' ? 'lg:col-span-2' : undefined}
              onHide={(id) => {
                setChartHidden(id, true);
              }}
            >
              {widgets[item.id]?.render()}
            </SortableWidget>
          ))}
        </div>
      </SortableZone>
    );
  }

  function noSnapshotMessage(
    isLoading: boolean,
    isError: boolean,
    onRetry: () => void,
    empty: string,
  ) {
    if (isLoading) return <LoadingLogo size="inline" />;
    if (isError) return <LoadErrorRetry onRetry={onRetry} />;
    return empty;
  }

  function renderHistoricalStatCards(): React.JSX.Element {
    const s = snapshot.data;
    const hasData = !snapshot.isLoading && fromDate !== '' && s != null && s.hasData;

    if (!hasData) {
      const msg =
        fromDate === ''
          ? t('dashboard.selectDate')
          : noSnapshotMessage(
              snapshot.isLoading,
              snapshot.isError,
              () => {
                void snapshot.refetch();
              },
              t('dashboard.noSnapshotData'),
            );
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    const d = isRange
      ? {
          date: t('dashboard.dateSpan', {
            from: formatCalendarDate(fromDate, { dateStyle: 'medium' }),
            to: formatCalendarDate(toDate, { dateStyle: 'medium' }),
          }),
        }
      : { date: formatCalendarDate(fromDate, { dateStyle: 'medium' }) };

    return (
      <>
        <StatGrid>
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
        </StatGrid>

        <StatGrid>
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
          {canSeeMoney && (
            <>
              <StatCard
                title={t('dashboard.dayRevenue')}
                value={formatMoney(money(s.dayRevenueCents), companyCurrency)}
                info={t('dashboard.historicalInfo.dayRevenue', d)}
              />
              <StatCard
                title={t('dashboard.dayTransactions')}
                value={money(s.dayTransactions)}
                info={t('dashboard.historicalInfo.dayTransactions', d)}
              />
            </>
          )}
        </StatGrid>

        <StatGrid>
          {canSeeMoney && (
            <>
              <StatCard
                title={t('dashboard.totalRevenue')}
                value={formatMoney(money(s.totalRevenueCents), companyCurrency)}
                info={t('dashboard.historicalInfo.totalRevenue', d)}
              />
              <StatCard
                title={t('dashboard.revenuePerSession')}
                value={formatMoney(money(s.avgRevenueCentsPerSession), companyCurrency)}
                info={t('dashboard.historicalInfo.revenuePerSession', d)}
              />
            </>
          )}
          <StatCard
            title={t('dashboard.totalSessions')}
            value={s.totalSessions}
            info={t('dashboard.historicalInfo.totalSessions', d)}
          />
          {canSeeMoney && (
            <StatCard
              title={t('dashboard.totalTransactions')}
              value={money(s.totalTransactions)}
              info={t('dashboard.historicalInfo.totalTransactions', d)}
            />
          )}
        </StatGrid>
      </>
    );
  }

  function renderTrendStatCards(): React.JSX.Element {
    const days = trendQuery.data?.days ?? [];
    const latest = days[0];

    if (trendQuery.isLoading || trendQuery.isError || days.length < 2 || latest == null) {
      const msg = noSnapshotMessage(
        trendQuery.isLoading,
        trendQuery.isError,
        () => {
          void trendQuery.refetch();
        },
        t('dashboard.notEnoughData'),
      );
      return <NoDataOverlay message={msg}>{renderLiveStatCards()}</NoDataOverlay>;
    }

    type NumericSnapshotKey = Exclude<keyof SnapshotData, 'hasData'>;
    const pluck = (key: NumericSnapshotKey): number[] => days.map((d) => d[key] ?? 0);
    const avg = (key: NumericSnapshotKey): number => {
      const vals = pluck(key);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldest = days[days.length - 1];
    const newest = days[0];
    const tr = {
      from: oldest != null ? formatCalendarDate(oldest.date) : '',
      to: newest != null ? formatCalendarDate(newest.date) : '',
    };

    return (
      <StatGrid>
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
        {canSeeMoney && (
          <TrendStatCard
            title={t('dashboard.dayRevenue')}
            value={formatMoney(Math.round(avg('dayRevenueCents')), companyCurrency)}
            data={pluck('dayRevenueCents')}
            info={t('dashboard.trendInfo.dayRevenue', tr)}
          />
        )}
        <TrendStatCard
          title={t('dashboard.dayEnergy')}
          value={formatEnergy(Math.round(avg('dayEnergyWh')))}
          data={pluck('dayEnergyWh')}
          info={t('dashboard.trendInfo.dayEnergy', tr)}
        />
        {canSeeMoney && (
          <TrendStatCard
            title={t('dashboard.revenuePerSession')}
            value={formatMoney(Math.round(avg('avgRevenueCentsPerSession')), companyCurrency)}
            data={pluck('avgRevenueCentsPerSession')}
            info={t('dashboard.trendInfo.revenuePerSession', tr)}
          />
        )}
        <TrendStatCard
          title={t('dashboard.totalSessions')}
          value={Math.round(avg('totalSessions'))}
          data={pluck('totalSessions')}
          info={t('dashboard.trendInfo.totalSessions', tr)}
        />
      </StatGrid>
    );
  }

  // Every chart of the Live view by widget id; `visible` holds the
  // permission gates: a saved layout only orders and hides, it never shows a
  // chart the user may not see.
  const chartWidgets: Record<string, DashboardWidgetView> = {
    'chart.aiInsights': {
      name: t('aiInsights.activeInsights'),
      visible: canReadInsights && featureFlags.flags.aiInsightsEnabled,
      render: () => <ActiveInsightsWidget />,
    },
    'chart.stationStatus': {
      name: t('charts.stationStatus'),
      visible: true,
      render: () => (
        <StationStatusChart
          data={stationStatus.data ?? []}
          info={t('dashboard.info.stationStatus')}
          state={queryState(stationStatus)}
        />
      ),
    },
    'chart.securityEvents': {
      name: t('dashboard.securityEvents.title'),
      visible: canReadSecurityEvents,
      render: () => <SecurityEventsCard />,
    },
    'chart.utilization': {
      name: t('charts.topUtilization'),
      visible: true,
      render: () => (
        <UtilizationChart
          data={utilization.data ?? []}
          actions={dateControl(utilRange)}
          info={t('dashboard.info.utilization')}
          state={queryState(utilization)}
        />
      ),
    },
    'chart.energy': {
      name: t('charts.energyDelivered'),
      visible: true,
      render: () => (
        <EnergyChart
          data={energyHistory.data ?? []}
          actions={dateControl(energy)}
          info={t('dashboard.info.energyChart')}
          state={queryState(energyHistory)}
        />
      ),
    },
    'chart.sessions': {
      name: t('charts.sessionsPerDay'),
      visible: true,
      render: () => (
        <SessionsChart
          data={sessionHistory.data ?? []}
          actions={dateControl(sessions)}
          info={t('dashboard.info.sessionsChart')}
          state={queryState(sessionHistory)}
        />
      ),
    },
    'chart.revenue': {
      name: t('charts.revenuePerDay'),
      visible: canSeeMoney,
      render: () => (
        <RevenueChart
          data={revenueHistory.data ?? []}
          currency={companyCurrency}
          currencyError={company.isError}
          onRetry={company.refetch}
          actions={dateControl(revenue)}
          info={t('dashboard.info.revenueChart')}
          state={queryState(revenueHistory)}
        />
      ),
    },
    'chart.paymentBreakdown': {
      name: t('charts.paymentBreakdown'),
      visible: canSeeMoney,
      render: () => (
        <PaymentBreakdownChart
          data={paymentBreakdown.data ?? []}
          info={t('dashboard.info.paymentBreakdown')}
          state={queryState(paymentBreakdown)}
        />
      ),
    },
    'chart.peakUsage': {
      name: t('charts.peakUsage'),
      visible: true,
      render: () => (
        <PeakUsageChart
          data={peakUsage.data ?? []}
          actions={dateControl(peak)}
          info={t('dashboard.info.peakUsage')}
          state={queryState(peakUsage)}
        />
      ),
    },
    'chart.activeSessions': {
      name: t('charts.activeSessions'),
      visible: canSeeSessions,
      render: () => (
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
            {activeSessions.isError ? (
              <LoadErrorRetry
                onRetry={() => {
                  void activeSessions.refetch();
                }}
              />
            ) : (
              <div className="space-y-4">
                <SessionsTable
                  sessions={activeSessions.data?.data}
                  page={activeSessionsPage}
                  totalPages={activeSessionsTotalPages}
                  onPageChange={setActiveSessionsPage}
                  timezone={timezone}
                  isLoading={activeSessions.isLoading}
                  emptyMessage={t('charts.noActiveSessions')}
                  sort={activeSessionsTableSort}
                  sortKeys={ALL_SESSIONS_SORT_KEYS}
                />
                {/* SessionsTable renders no page controls: every caller adds them. */}
                <Pagination
                  page={activeSessionsPage}
                  totalPages={activeSessionsTotalPages}
                  onPageChange={setActiveSessionsPage}
                />
              </div>
            )}
          </CardContent>
        </Card>
      ),
    },
    'chart.siteLayout3d': {
      name: t('dashboard.siteLayout.title'),
      visible: canReadSites,
      render: () => (
        <SiteLayoutWidget
          siteId={siteLayoutItem?.siteId ?? null}
          siteUnavailable={siteLayoutItem?.siteUnavailable === true}
          onSiteChange={setLayoutSite}
        />
      ),
    },
    'chart.stationMap': {
      name: t('dashboard.siteMap'),
      visible: true,
      render: () => <StationMapChart info={t('dashboard.info.siteMap')} />,
    },
    'chart.locationsByCity': {
      name: t('dashboard.locationsByCity'),
      visible: true,
      render: () => (
        <LocationsByCityChart
          data={locationsByCity.data}
          info={t('dashboard.locationsByCityInfo')}
          state={queryState(locationsByCity)}
        />
      ),
    },
    'chart.evsesByConnectorType': {
      name: t('dashboard.evsesByConnectorType'),
      visible: true,
      render: () => (
        <EvsesByConnectorTypeChart
          data={evsesByConnectorType.data ?? []}
          info={t('dashboard.evsesByConnectorTypeInfo')}
          state={queryState(evsesByConnectorType)}
        />
      ),
    },
    'chart.plugAndCharge': {
      name: t('dashboard.plugAndCharge'),
      visible: true,
      render: () => (
        <PlugAndChargeChart
          data={plugAndCharge.data}
          actions={dateControl(pncRange)}
          info={t('dashboard.plugAndChargeInfo')}
          state={queryState(plugAndCharge)}
        />
      ),
    },
    'chart.freeVend': {
      name: t('dashboard.freeVend'),
      visible: true,
      render: () => (
        <FreeVendChart
          data={freeVend.data}
          actions={dateControl(freeVendRange)}
          info={t('dashboard.freeVendInfo')}
          state={queryState(freeVend)}
        />
      ),
    },
  };

  // The hidden charts the user may see, offered back while customizing.
  const hiddenWidgets =
    dashboardLayout.layout == null
      ? []
      : [...dashboardLayout.layout.charts.map((i) => ({ item: i, widget: chartWidgets[i.id] }))]
          .filter(({ item, widget }) => item.hidden && widget?.visible === true)
          .map(({ item, widget }) => ({ id: item.id, name: widget?.name ?? item.id }));

  return (
    <>
      {canSeeMoney && company.isError && <LoadErrorRetry onRetry={company.refetch} />}
      {editing && dashboardLayout.layout != null && (
        <DashboardCustomizeBar
          hidden={hiddenWidgets}
          onShow={(id) => {
            setChartHidden(id, false);
          }}
          onReset={dashboardLayout.reset}
          isResetting={dashboardLayout.isResetting}
        />
      )}
      {/* Historical and Trend keep the Live cards' height so the charts do not
          jump between modes; both share one grid cell, so the taller one sets it. */}
      <div className="grid">
        {mode !== 'live' && (
          <div
            className="invisible col-start-1 row-start-1 hidden space-y-4 lg:block"
            aria-hidden="true"
          >
            {renderLiveStatCards()}
          </div>
        )}
        <div className="col-start-1 row-start-1 space-y-4">
          {mode === 'live' && renderLiveStatCards()}
          {mode === 'historical' && renderHistoricalStatCards()}
          {mode === 'trend' && renderTrendStatCards()}
        </div>
      </div>

      {/* The feature flags decide whether Active insights shows above the
          charts: render the charts once they answered, so the grid never
          shifts under a chart being moved. */}
      {layout == null || featureFlags.isLoading ? (
        <LoadingLogo size="inline" />
      ) : (
        renderCharts(layout.charts, chartWidgets, editing)
      )}
    </>
  );
}

export function Dashboard(): React.JSX.Element {
  const { t } = useTranslation();
  useUpdateCheck();
  const [mode, setMode] = useState<DashboardMode>('live');
  const [editing, setEditing] = useState(false);
  const historical = useDateRange();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('dashboard.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'live' && (
            <DashboardCustomizeButton editing={editing} onEditingChange={setEditing} />
          )}
          <ModeToggle
            mode={mode}
            onModeChange={(next) => {
              setMode(next);
              // Customizing applies to the Live view only.
              if (next !== 'live') setEditing(false);
            }}
            range={historical}
          />
        </div>
      </div>
      <DashboardBody
        mode={mode}
        editing={mode === 'live' && editing}
        fromDate={historical.effectiveFrom}
        toDate={historical.effectiveTo}
      />
    </div>
  );
}
