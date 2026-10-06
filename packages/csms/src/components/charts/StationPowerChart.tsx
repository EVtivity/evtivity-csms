// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { formatChartTime, useUserTimezone } from '@/lib/timezone';

interface MeterValueSeries {
  measurand: string;
  unit: string | null;
  values: { timestamp: string; value: string }[];
}

interface StationPowerChartProps {
  data: MeterValueSeries[];
}

export function StationPowerChart({ data }: StationPowerChartProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const timezone = useUserTimezone();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const powerSeries = data.find((s) => s.measurand === 'Power.Active.Import');

  const unit = powerSeries?.unit ?? 'W';
  const divisor = unit === 'W' || unit === 'Wh' ? 1000 : 1;
  const values = powerSeries?.values;

  const seriesData = useMemo(
    () =>
      (values ?? []).map((v) => ({
        x: new Date(v.timestamp).getTime(),
        y: Number(v.value) / divisor,
      })),
    [values, divisor],
  );

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
        type: 'datetime',
        labels: {
          // ApexCharts formats in UTC with English month names; use the user time zone and
          // UI language instead.
          datetimeUTC: false,
          formatter: (_value: string, timestamp?: number) =>
            timestamp == null ? '' : formatChartTime(timestamp, timezone),
        },
      },
      yaxis: {
        // Anchor at zero so an idle station draws a visible flat line on the
        // baseline instead of an apparently empty chart.
        min: 0,
        title: { text: t('charts.kW') },
        labels: {
          formatter: (val: number) => formatNumber(val, 1),
        },
      },
      tooltip: {
        x: { formatter: (val: number) => formatChartTime(val, timezone) },
        y: {
          formatter: (val: number) => t('charts.powerValue', { value: formatNumber(val, 2) }),
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
    [isDark, t, timezone, i18n.language],
  );

  const series = useMemo(() => [{ name: t('charts.power'), data: seriesData }], [t, seriesData]);

  if (powerSeries == null || powerSeries.values.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('charts.powerKw')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">{t('charts.noPowerData')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('charts.powerKw')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={series} type="line" height={300} />
      </CardContent>
    </Card>
  );
}
