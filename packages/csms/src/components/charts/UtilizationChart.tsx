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

interface UtilizationChartProps {
  data: { site: string; utilization: number }[];
  actions?: React.ReactNode;
  info?: string;
}

export function UtilizationChart({
  data,
  actions,
  info,
}: UtilizationChartProps): React.JSX.Element {
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
      grid: {
        borderColor: getGridColor(isDark),
        xaxis: { lines: { show: true } },
        yaxis: { lines: { show: false } },
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 4,
          barHeight: '60%',
          dataLabels: { position: 'center' },
        },
      },
      xaxis: {
        labels: {
          formatter: (val: string) => `${val}%`,
        },
      },
      yaxis: {
        labels: {
          maxWidth: 150,
        },
      },
      dataLabels: {
        enabled: true,
        formatter: (val: number) => `${String(val)}%`,
        style: { fontSize: '12px', fontWeight: 600 },
      },
      tooltip: {
        y: {
          formatter: (val: number) => `${String(val)}%`,
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
    [isDark],
  );

  const series = useMemo(
    () => [
      {
        name: t('charts.utilization'),
        data: data.map((d) => ({
          x: d.site,
          y: d.utilization,
        })),
      },
    ],
    [t, data],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('charts.topUtilization')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={series} type="bar" height={300} />
      </CardContent>
    </Card>
  );
}
