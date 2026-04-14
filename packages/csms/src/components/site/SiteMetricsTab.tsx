// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { StationPowerChart } from '@/components/charts/StationPowerChart';
import { StationEnergyChart } from '@/components/charts/StationEnergyChart';
import { RevenueChart } from '@/components/charts/RevenueChart';
import { PopularTimesChart } from '@/components/charts/PopularTimesChart';
import { api } from '@/lib/api';
import { formatEnergy, formatDurationMinutes } from '@/lib/formatting';

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
  totalRevenueCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
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

  const { data: metrics } = useQuery({
    queryKey: ['sites', siteId, 'metrics'],
    queryFn: () => api.get<SiteMetrics>(`/v1/sites/${siteId}/metrics`),
    refetchInterval: 60_000,
  });

  const { data: meterData } = useQuery({
    queryKey: ['sites', siteId, 'meter-values'],
    queryFn: () => api.get<MeterValueSeries[]>(`/v1/sites/${siteId}/meter-values?hours=24`),
    refetchInterval: 30_000,
  });

  const { data: energyData } = useQuery({
    queryKey: ['sites', siteId, 'energy-history'],
    queryFn: () =>
      api.get<{ date: string; energyWh: number }[]>(`/v1/sites/${siteId}/energy-history?days=7`),
  });

  const { data: revenueData } = useQuery({
    queryKey: ['sites', siteId, 'revenue-history'],
    queryFn: () =>
      api.get<{ date: string; revenueCents: number; sessionCount: number }[]>(
        `/v1/sites/${siteId}/revenue-history?days=7`,
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
    <TabsContent value="metrics" className="space-y-6">
      {metrics != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.siteMetrics')}</CardTitle>
          </CardHeader>
          <CardContent>
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
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('metrics.totalRevenue')}</p>
                <p className="text-2xl font-bold">
                  ${(metrics.totalRevenueCents / 100).toFixed(2)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('metrics.revenuePerSession')}</p>
                <p className="text-2xl font-bold">
                  ${(metrics.avgRevenueCentsPerSession / 100).toFixed(2)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('metrics.totalTransactions')}</p>
                <p className="text-2xl font-bold">{String(metrics.totalTransactions)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {meterData != null && <StationPowerChart data={meterData} />}
        {energyData != null && <StationEnergyChart data={energyData} />}
      </div>

      {revenueData != null && revenueData.length > 0 && <RevenueChart data={revenueData} />}

      {popularTimesData != null && popularTimesData.length > 0 && (
        <PopularTimesChart data={popularTimesData} />
      )}
    </TabsContent>
  );
}
