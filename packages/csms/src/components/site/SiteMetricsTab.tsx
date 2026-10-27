// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { TabPanel } from '@/components/ui/tab-panel';
import { StationPowerChart } from '@/components/charts/StationPowerChart';
import { StationEnergyChart } from '@/components/charts/StationEnergyChart';
import { RevenueChart } from '@/components/charts/RevenueChart';
import { PopularTimesChart } from '@/components/charts/PopularTimesChart';
import { DateRangeControl } from '@/components/DateRangeControl';
import { useDateRange } from '@/hooks/useDateRange';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatCents, formatEnergy, formatDurationMinutes } from '@/lib/formatting';

interface SiteMetrics {
  uptimePercent: number;
  portCount: number;
  utilizationPercent: number;
  totalSessions: number;
  completedSessions: number;
  faultedSessions: number;
  sessionSuccessPercent: number;
  totalEnergyWh: number;
  avgSessionDurationMinutes: number;
  disconnectCount: number;
  avgDowntimeMinutes: number;
  maxDowntimeMinutes: number;
  totalRevenueCents: number | null;
  avgRevenueCentsPerSession: number | null;
  totalTransactions: number;
  totalElectricityCostCents: number | null;
  totalNetRevenueCents: number | null;
  totalTaxCents: number | null;
  totalProfitCents: number | null;
  costMissingSessionCount?: number;
  currency: string;
  periodMonths: number;
}

interface MeterValueSeries {
  measurand: string;
  unit: string | null;
  values: { timestamp: string; value: string }[];
}

function uptimeColor(pct: number): string {
  if (pct >= 97) return 'text-green-600';
  if (pct >= 90) return 'text-yellow-600';
  return 'text-red-600';
}

export interface SiteMetricsTabProps {
  siteId: string;
}

export function SiteMetricsTab({ siteId }: SiteMetricsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  // Revenue, tax, cost and profit need payments:read, as the API.
  const canReadPayments = useHasPermission('payments:read');

  const energyRange = useDateRange();
  const revenueRange = useDateRange();

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

  const {
    data: metrics,
    isLoading: metricsLoading,
    isError: metricsError,
    refetch: refetchMetrics,
  } = useQuery({
    queryKey: ['sites', siteId, 'metrics'],
    queryFn: () => api.get<SiteMetrics>(`/v1/sites/${siteId}/metrics`),
    refetchInterval: 60_000,
  });

  const { data: meterData } = useQuery({
    queryKey: ['sites', siteId, 'meter-values'],
    queryFn: () =>
      api.get<MeterValueSeries[]>(
        `/v1/sites/${siteId}/meter-values?hours=24&measurand=Power.Active.Import`,
      ),
    refetchInterval: 30_000,
  });

  const { data: energyData } = useQuery({
    queryKey: ['sites', siteId, 'energy-history', energyRange.dateQuery],
    queryFn: () =>
      api.get<{ date: string; energyWh: number }[]>(`/v1/sites/${siteId}/energy-history?days=7`),
  });

  const { data: revenueData } = useQuery({
    queryKey: ['sites', siteId, 'revenue-history', revenueRange.dateQuery],
    queryFn: () =>
      api.get<{ date: string; revenueCents: number | null; sessionCount: number }[]>(
        `/v1/sites/${siteId}/revenue-history?${revenueRange.dateQuery}`,
      ),
  });

  const { data: popularTimesData } = useQuery({
    queryKey: ['sites', siteId, 'popular-times'],
    queryFn: () =>
      api.get<{ dow: number; hour: number; avgSessions: number }[]>(
        `/v1/sites/${siteId}/popular-times?weeks=4`,
      ),
  });

  return (
    <>
      <TabPanel
        title={t('sites.metrics')}
        isLoading={metricsLoading}
        isError={metricsError}
        onRetry={() => {
          void refetchMetrics();
        }}
      >
        {metrics != null && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.uptime')}</p>
              <p className={`text-2xl font-bold ${uptimeColor(metrics.uptimePercent)}`}>
                {String(metrics.uptimePercent)}%
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.utilization')}</p>
              <p className="text-2xl font-bold">{String(metrics.utilizationPercent)}%</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.sessionSuccess')}</p>
              <p className="text-2xl font-bold">{String(metrics.sessionSuccessPercent)}%</p>
              <p className="text-xs text-muted-foreground">
                {String(metrics.completedSessions)}/{String(metrics.totalSessions)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.energyDelivered')}</p>
              <p className="text-2xl font-bold">{formatEnergy(metrics.totalEnergyWh)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.avgSession')}</p>
              <p className="text-2xl font-bold">
                {formatDurationMinutes(metrics.avgSessionDurationMinutes)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.faultedSessions')}</p>
              <p className="text-2xl font-bold">{String(metrics.faultedSessions)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.disconnects')}</p>
              <p className="text-2xl font-bold">{String(metrics.disconnectCount)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.avgDowntime')}</p>
              <p className="text-2xl font-bold">
                {formatDurationMinutes(metrics.avgDowntimeMinutes)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('metrics.maxDowntime')}</p>
              <p className="text-2xl font-bold">
                {formatDurationMinutes(metrics.maxDowntimeMinutes)}
              </p>
            </div>
            {canReadPayments && (
              <>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.totalRevenue')}</p>
                  <p className="text-2xl font-bold">
                    {formatCents(metrics.totalRevenueCents ?? 0, metrics.currency)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.netRevenue')}</p>
                  <p className="text-2xl font-bold">
                    {formatCents(metrics.totalNetRevenueCents ?? 0, metrics.currency)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.taxCollected')}</p>
                  <p className="text-2xl font-bold">
                    {formatCents(metrics.totalTaxCents ?? 0, metrics.currency)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.revenuePerSession')}</p>
                  <p className="text-2xl font-bold">
                    {formatCents(metrics.avgRevenueCentsPerSession ?? 0, metrics.currency)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.totalTransactions')}</p>
                  <p className="text-2xl font-bold">{String(metrics.totalTransactions)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.electricityCost')}</p>
                  <p className="text-2xl font-bold">
                    {formatCents(metrics.totalElectricityCostCents ?? 0, metrics.currency)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('metrics.profit')}</p>
                  <p
                    className={`text-2xl font-bold ${(metrics.totalProfitCents ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}
                  >
                    {formatCents(metrics.totalProfitCents ?? 0, metrics.currency)}
                  </p>
                  {(metrics.costMissingSessionCount ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('metrics.costMissing', { count: metrics.costMissingSessionCount })}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </TabPanel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {meterData != null && <StationPowerChart data={meterData} />}
        <StationEnergyChart data={energyData ?? []} actions={dateControl(energyRange)} />
      </div>

      {canReadPayments && (
        <RevenueChart
          data={(revenueData ?? []).map((d) => ({ ...d, revenueCents: d.revenueCents ?? 0 }))}
          currency={metrics?.currency}
          currencyError={metricsError}
          onRetry={() => {
            void refetchMetrics();
          }}
          actions={dateControl(revenueRange)}
        />
      )}

      {popularTimesData != null && popularTimesData.length > 0 && (
        <PopularTimesChart data={popularTimesData} />
      )}
    </>
  );
}
