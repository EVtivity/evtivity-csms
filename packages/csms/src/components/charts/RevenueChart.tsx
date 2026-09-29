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
import { LoadingLogo } from '@/components/loading-logo';
import { Button } from '@/components/ui/button';

interface RevenueChartProps {
  data: { date: string; revenueCents: number; sessionCount: number }[];
  /** Undefined while the currency loads or after it failed to load. */
  currency: string | undefined;
  currencyError?: boolean;
  onRetry?: () => void;
  title?: string;
  actions?: React.ReactNode;
  info?: string;
}

export function RevenueChart({
  data,
  currency,
  currencyError = false,
  onRetry,
  title,
  actions,
  info,
}: RevenueChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const resolvedTitle = title ?? t('charts.revenuePerDay');
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
        title: { text: currency ?? '' },
        labels: {
          formatter: (val: number) => (currency != null ? formatCents(val, currency) : ''),
        },
      },
      tooltip: {
        y: {
          formatter: (val: number) => (currency != null ? formatCents(val, currency) : ''),
        },
      },
      colors: [CHART_COLORS.violet],
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
          },
        },
      ],
    }),
    [isDark, data, currency],
  );

  const series = useMemo(
    () => [{ name: t('charts.revenue'), data: data.map((d) => d.revenueCents) }],
    [t, data],
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
        {data.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('charts.noRevenueData')}</p>
        ) : currency == null && currencyError ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-center text-sm text-destructive">{t('common.loadError')}</p>
            {onRetry != null && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        ) : currency == null ? (
          <LoadingLogo size="inline" />
        ) : (
          <ReactApexChart options={options} series={series} type="line" height={300} />
        )}
      </CardContent>
    </Card>
  );
}
