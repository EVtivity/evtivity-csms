// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';

interface StationUptimeChartProps {
  data: { date: string; uptimePercent: number }[];
}

export function StationUptimeChart({ data }: StationUptimeChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('charts.uptimePerDay')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('charts.noUptimeData')}</p>
        </CardContent>
      </Card>
    );
  }

  const options = useMemo<ApexOptions>(
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
      dataLabels: { enabled: false },
      stroke: { curve: 'smooth', width: 2 },
      fill: {
        type: 'gradient',
        gradient: { opacityFrom: 0.4, opacityTo: 0.05 },
      },
      xaxis: {
        categories: data.map((d) => d.date),
        labels: {
          formatter: (val: string) => {
            const date = new Date(val);
            return `${String(date.getMonth() + 1)}/${String(date.getDate())}`;
          },
        },
      },
      yaxis: {
        title: { text: '%' },
        min: 0,
        max: 100,
        labels: {
          formatter: (val: number) => `${val.toFixed(0)}%`,
        },
      },
      tooltip: {
        y: {
          formatter: (val: number) => `${val.toFixed(1)}%`,
        },
      },
      colors: [CHART_COLORS.success],
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
          },
        },
      ],
    }),
    [isDark, data],
  );

  const series = useMemo(
    () => [{ name: t('charts.uptime'), data: data.map((d) => d.uptimePercent) }],
    [t, data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('charts.uptimePerDay')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={series} type="area" height={300} />
      </CardContent>
    </Card>
  );
}
