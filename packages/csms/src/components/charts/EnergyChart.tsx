// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';

interface EnergyChartProps {
  data: { date: string; energyWh: number }[];
  title?: string;
  actions?: React.ReactNode;
  info?: string;
}

export function EnergyChart({ data, title, actions, info }: EnergyChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const resolvedTitle = title ?? t('charts.energyDelivered');
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
        categories: data.map((d) => d.date),
        labels: {
          formatter: (val: string) => {
            const date = new Date(val);
            return `${String(date.getMonth() + 1)}/${String(date.getDate())}`;
          },
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
        <CardTitle className="text-base flex items-center gap-1.5">
          {resolvedTitle}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={series} type="line" height={300} />
      </CardContent>
    </Card>
  );
}
