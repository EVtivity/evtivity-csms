// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor, formatChartDateLabel } from '@/lib/chart-theme';
import { formatCents } from '@/lib/formatting';
import { currenciesIn, type DailyRevenue } from '@/lib/currency-amounts';

const SERIES_COLORS = [
  CHART_COLORS.violet,
  CHART_COLORS.accent,
  CHART_COLORS.warning,
  CHART_COLORS.success,
  CHART_COLORS.primary,
  CHART_COLORS.destructive,
];

interface RevenueChartProps {
  data: DailyRevenue[];
  title?: string;
  actions?: React.ReactNode;
  info?: string;
}

export function RevenueChart({ data, title, actions, info }: RevenueChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const resolvedTitle = title ?? t('charts.revenuePerDay');
  // One series per currency: amounts in different currencies are never added.
  const currencies = useMemo(() => currenciesIn(data), [data]);
  const single = currencies.length === 1 ? currencies[0] : undefined;
  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'line',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        background: 'transparent',
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      grid: { borderColor: getGridColor(isDark) },
      stroke: { curve: 'smooth', width: 2 },
      xaxis: {
        // Pin the axis type: line charts otherwise convert date-like string
        // categories to a numeric axis, which blanks the chart when the
        // label formatter receives numbers.
        type: 'category',
        categories: data.map((d) => d.date),
        labels: {
          formatter: formatChartDateLabel,
        },
      },
      yaxis: {
        title: { text: single ?? '' },
        labels: {
          formatter: (val: number) => (val / 100).toFixed(0),
        },
      },
      tooltip: {
        y: {
          formatter: (val: number, opts?: { seriesIndex: number }) =>
            formatCents(val, currencies[opts?.seriesIndex ?? 0] ?? single),
        },
      },
      colors: SERIES_COLORS,
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
          },
        },
      ],
    }),
    [isDark, data, currencies, single],
  );

  const series = useMemo(
    () =>
      currencies.map((currency) => ({
        name: t('charts.revenueInCurrency', { currency }),
        data: data.map((d) => d.revenue.find((r) => r.currency === currency)?.revenueCents ?? 0),
      })),
    [t, data, currencies],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {resolvedTitle}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        {currencies.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('charts.noRevenueData')}</p>
        ) : (
          <ReactApexChart options={options} series={series} type="line" height={300} />
        )}
      </CardContent>
    </Card>
  );
}
