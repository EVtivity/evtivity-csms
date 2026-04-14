// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Download, Leaf, Zap, Activity, TreePine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { api } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { useAuth } from '@/lib/auth';
import { formatCo2, formatEnergy } from '@/lib/formatting';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';

interface SustainabilityReportData {
  summary: {
    totalCo2AvoidedKg: number;
    totalEnergyWh: number;
    totalSessions: number;
    treesEquivalent: number;
  };
  monthly: {
    month: string;
    co2AvoidedKg: number;
    energyWh: number;
    sessions: number;
  }[];
  sites: {
    siteId: string;
    siteName: string;
    co2AvoidedKg: number;
    energyWh: number;
    sessions: number;
  }[];
}

interface SiteOption {
  id: string;
  name: string;
}

export function SustainabilityTab(): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';

  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 30);
  const [fromDate, setFromDate] = useState(thirtyDaysAgo.toISOString().split('T')[0] ?? '');
  const [toDate, setToDate] = useState(today.toISOString().split('T')[0] ?? '');
  const [siteId, setSiteId] = useState('');

  const { data: sitesData } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
  });

  const queryParams = new URLSearchParams();
  if (fromDate !== '') queryParams.set('from', fromDate);
  if (toDate !== '') queryParams.set('to', toDate);
  if (siteId !== '') queryParams.set('siteId', siteId);

  const { data: report, isLoading } = useQuery({
    queryKey: ['carbon-report', fromDate, toDate, siteId],
    queryFn: () => api.get<SustainabilityReportData>(`/v1/carbon/report?${queryParams.toString()}`),
    enabled: fromDate !== '' && toDate !== '',
  });

  const chartOptions = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'area',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        background: 'transparent',
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      grid: { borderColor: getGridColor(isDark) },
      stroke: { curve: 'smooth', width: 2 },
      fill: {
        type: 'gradient',
        gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05 },
      },
      xaxis: {
        categories: (report?.monthly ?? []).map((m) => m.month),
        labels: {
          formatter: (val: string) => {
            const d = new Date(val + '-01');
            return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
          },
        },
      },
      yaxis: {
        title: { text: 'kg CO2' },
        labels: {
          formatter: (val: number) => val.toFixed(0),
        },
      },
      tooltip: {
        y: {
          formatter: (val: number) => `${val.toFixed(1)} kg`,
        },
      },
      colors: [CHART_COLORS.success],
    }),
    [isDark, report?.monthly],
  );

  const chartSeries = useMemo(
    () => [
      {
        name: t('sustainability.totalCo2Avoided'),
        data: (report?.monthly ?? []).map((m) => Math.round(m.co2AvoidedKg * 10) / 10),
      },
    ],
    [t, report?.monthly],
  );

  function handleExportCsv(): void {
    const params = new URLSearchParams();
    if (fromDate !== '') params.set('from', fromDate);
    if (toDate !== '') params.set('to', toDate);
    if (siteId !== '') params.set('siteId', siteId);

    const url = `${API_BASE_URL}/v1/carbon/report/export?${params.toString()}`;
    void fetch(url, {
      credentials: 'include',
    })
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sustainability-report-${fromDate}-${toDate}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Start date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              max={toDate}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              aria-label="End date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              min={fromDate}
              max={today.toISOString().split('T')[0] ?? ''}
            />
            <ResponsiveFilters activeCount={siteId ? 1 : 0}>
              <Select
                aria-label="Filter by site"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                }}
                className="h-9 w-auto"
              >
                <option value="">{t('sessions.allSites')}</option>
                {sitesData?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </ResponsiveFilters>
          </div>
          <Button variant="outline" onClick={handleExportCsv} className="gap-1.5">
            <Download className="h-4 w-4" />
            {t('sustainability.exportCsv')}
          </Button>
        </CardContent>
      </Card>

      {isLoading && <p className="text-muted-foreground">{t('common.loading')}</p>}

      {report?.summary != null && (
        <>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('sustainability.totalCo2Avoided')}
                </CardTitle>
                <Leaf className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-lg sm:text-2xl font-bold text-success">
                  {formatCo2(report.summary.totalCo2AvoidedKg)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('dashboard.energyDelivered')}
                </CardTitle>
                <Zap className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-lg sm:text-2xl font-bold">
                  {formatEnergy(report.summary.totalEnergyWh)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('dashboard.totalSessions')}
                </CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-lg sm:text-2xl font-bold">
                  {report.summary.totalSessions.toLocaleString()}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('sustainability.treesEquivalent')}
                </CardTitle>
                <TreePine className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-lg sm:text-2xl font-bold text-success">
                  {report.summary.treesEquivalent.toLocaleString()}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sustainability.monthlyTrend')}</CardTitle>
            </CardHeader>
            <CardContent>
              {report.monthly.length > 0 ? (
                <ReactApexChart
                  options={chartOptions}
                  series={chartSeries}
                  type="area"
                  height={300}
                />
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No data for selected period
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sustainability.siteBreakdown')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('sites.siteName')}</TableHead>
                      <TableHead className="text-right">{t('sessions.energy')}</TableHead>
                      <TableHead className="text-right">{t('dashboard.totalSessions')}</TableHead>
                      <TableHead className="text-right">{t('dashboard.co2Avoided')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.sites.map((site) => (
                      <TableRow key={site.siteId}>
                        <TableCell>{site.siteName}</TableCell>
                        <TableCell className="text-right">{formatEnergy(site.energyWh)}</TableCell>
                        <TableCell className="text-right">
                          {site.sessions.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right text-success">
                          {formatCo2(site.co2AvoidedKg)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {report.sites.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">
                          No data for selected period
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
