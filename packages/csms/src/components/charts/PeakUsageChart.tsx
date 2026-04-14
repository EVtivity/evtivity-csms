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

interface PeakUsageChartProps {
  data: { hour: number; dayOfWeek: number; count: number }[];
  actions?: React.ReactNode;
  info?: string;
}

export function PeakUsageChart({ data, actions, info }: PeakUsageChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const dayNames = [
    t('charts.mon'),
    t('charts.tue'),
    t('charts.wed'),
    t('charts.thu'),
    t('charts.fri'),
    t('charts.sat'),
    t('charts.sun'),
  ];
  const seriesData = useMemo(
    () =>
      dayNames.map((day, dayIdx) => ({
        name: day,
        data: Array.from({ length: 24 }, (_, hour) => {
          const match = data.find((d) => d.dayOfWeek === dayIdx + 1 && d.hour === hour);
          return { x: `${String(hour).padStart(2, '0')}:00`, y: match?.count ?? 0 };
        }),
      })),
    [dayNames, data],
  );

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'heatmap',
        toolbar: { show: false },
        fontFamily: 'inherit',
        background: 'transparent',
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      grid: { borderColor: getGridColor(isDark) },
      stroke: { show: true, colors: [isDark ? '#0f172a' : '#ffffff'], width: 1 },
      dataLabels: { enabled: false },
      colors: [CHART_COLORS.primary],
      xaxis: {
        labels: {
          rotate: -45,
          hideOverlappingLabels: true,
        },
      },
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
            xaxis: {
              labels: { show: false },
            },
          },
        },
      ],
    }),
    [isDark],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('charts.peakUsage')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={seriesData} type="heatmap" height={300} />
      </CardContent>
    </Card>
  );
}
