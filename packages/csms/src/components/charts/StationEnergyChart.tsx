// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor, formatChartDateLabel } from '@/lib/chart-theme';

interface StationEnergyChartProps {
  data: { date: string; energyWh: number }[];
  actions?: React.ReactNode;
}

export function StationEnergyChart({ data, actions }: StationEnergyChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'bar',
        toolbar: { show: false },
        fontFamily: 'inherit',
        background: 'transparent',
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      grid: { borderColor: getGridColor(isDark) },
      plotOptions: {
        bar: { borderRadius: 4, columnWidth: '60%' },
      },
      dataLabels: {
        formatter: (val: number) => (val / 1000).toFixed(1),
      },
      xaxis: {
        categories: data.map((d) => d.date),
        labels: {
          formatter: formatChartDateLabel,
        },
      },
      yaxis: {
        title: { text: t('charts.kWh') },
        labels: {
          formatter: (val: number) => (val / 1000).toFixed(1),
        },
      },
      tooltip: {
        y: {
          formatter: (val: number) => t('charts.energyValue', { value: (val / 1000).toFixed(2) }),
        },
      },
      colors: [CHART_COLORS.primary],
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
          },
        },
      ],
    }),
    [isDark, data, t],
  );

  const series = useMemo(
    () => [{ name: t('charts.energy'), data: data.map((d) => d.energyWh) }],
    [t, data],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{t('charts.energyKwhPerDay')}</CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('charts.noEnergyData')}</p>
        ) : (
          <ReactApexChart options={options} series={series} type="bar" height={300} />
        )}
      </CardContent>
    </Card>
  );
}
