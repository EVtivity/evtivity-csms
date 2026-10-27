// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, formatChartDateLabel, getGridColor } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { ChartBody, type QueryState } from './ChartBody';

export interface SessionActivityData {
  days: Array<{ date: string; sessionCount: number; energyWh: number }>;
  totals: { sessionCount: number; energyWh: number };
}

/**
 * Sessions per day (bars) and their energy (line, kWh) of one kind of
 * session, with a summary line under the title. The Plug and Charge and free
 * vend charts render through it.
 */
export function SessionActivityChart({
  title,
  summary,
  data,
  actions,
  info,
  emptyText,
  state,
}: {
  title: string;
  /** Lines under the title (totals, counts). */
  summary: string[];
  data: SessionActivityData | undefined;
  actions?: React.ReactNode | undefined;
  info?: string | undefined;
  emptyText: string;
  state?: QueryState | undefined;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const days = useMemo(() => data?.days ?? [], [data]);

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
      stroke: { width: [0, 2], curve: 'smooth' },
      plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
      xaxis: {
        type: 'category',
        categories: days.map((d) => d.date),
        labels: { formatter: formatChartDateLabel },
      },
      yaxis: [
        {
          title: { text: t('charts.sessions') },
          labels: { formatter: (val: number) => formatNumber(val, 0) },
        },
        {
          opposite: true,
          title: { text: t('charts.kWh') },
          labels: { formatter: (val: number) => formatNumber(val, 1) },
        },
      ],
      tooltip: {
        shared: true,
        y: [
          { formatter: (val: number) => formatNumber(val, 0) },
          { formatter: (val: number) => t('charts.energyValue', { value: formatNumber(val, 2) }) },
        ],
      },
      dataLabels: { enabled: false },
      colors: [CHART_COLORS.primary, CHART_COLORS.success],
      responsive: [{ breakpoint: 768, options: { chart: { height: 250 } } }],
    }),
    [isDark, days, t, i18n.language],
  );

  const series = useMemo(
    () => [
      { name: t('charts.sessions'), type: 'column', data: days.map((d) => d.sessionCount) },
      { name: t('charts.energy'), type: 'line', data: days.map((d) => d.energyWh / 1000) },
    ],
    [t, days],
  );

  const isEmpty = data == null || data.totals.sessionCount === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-1.5">
            {title}
            {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
          </CardTitle>
          {summary.map((line) => (
            <p key={line} className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
        {actions}
      </CardHeader>
      <CardContent>
        <ChartBody state={state} isEmpty={isEmpty} emptyText={emptyText}>
          <ReactApexChart options={options} series={series} type="line" height={300} />
        </ChartBody>
      </CardContent>
    </Card>
  );
}
