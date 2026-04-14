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

interface SessionsChartProps {
  data: { date: string; count: number }[];
  actions?: React.ReactNode;
  info?: string;
}

export function SessionsChart({ data, actions, info }: SessionsChartProps): React.JSX.Element {
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
        title: { text: t('charts.sessions') },
        labels: {
          formatter: (val: number) => String(Math.round(val)),
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
    () => [{ name: t('charts.sessions'), data: data.map((d) => d.count) }],
    [t, data],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('charts.sessionsPerDay')}
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
