// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useTranslation } from 'react-i18next';
import { ChartBody, type QueryState } from './ChartBody';
import { formatUtilizationPercent, relativeBarLengths } from './utilization-format';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';

interface UtilizationChartProps {
  data: { site: string; utilization: number }[];
  actions?: React.ReactNode;
  info?: string;
  /** The state of the query behind the chart; omitted, the chart shows as given. */
  state?: QueryState;
}

export function UtilizationChart({
  data,
  actions,
  info,
  state,
}: UtilizationChartProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
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
        // Explicit categories: horizontal bars with {x,y} series data fall
        // back to numeric row indexes for the category labels.
        type: 'category',
        categories: data.map((d) => d.site),
        // Bars are relative to the busiest site, so the axis has no percent scale.
        max: 100,
        labels: { show: false },
      },
      yaxis: {
        labels: {
          maxWidth: 150,
        },
      },
      dataLabels: { enabled: false },
      tooltip: {
        y: {
          // The real utilization of the site, not the relative bar length.
          formatter: (_val: number, opts?: { dataPointIndex?: number }) =>
            formatUtilizationPercent(data[opts?.dataPointIndex ?? -1]?.utilization ?? 0),
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
    [isDark, data, i18n.language],
  );

  const series = useMemo(
    () => [
      {
        name: t('charts.utilization'),
        data: relativeBarLengths(data.map((d) => d.utilization)),
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
        <ChartBody state={state} isEmpty={data.length === 0} emptyText={t('charts.noData')}>
          <ReactApexChart options={options} series={series} type="bar" height={300} />
        </ChartBody>
      </CardContent>
    </Card>
  );
}
