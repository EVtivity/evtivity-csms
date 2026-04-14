// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';

interface MeterValueSeries {
  measurand: string;
  unit: string | null;
  values: { timestamp: string; value: string }[];
}

interface StationPowerChartProps {
  data: MeterValueSeries[];
}

export function StationPowerChart({ data }: StationPowerChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const powerSeries = data.find((s) => s.measurand === 'Power.Active.Import');

  if (powerSeries == null || powerSeries.values.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('charts.powerKw')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('charts.noPowerData')}</p>
        </CardContent>
      </Card>
    );
  }

  const unit = powerSeries.unit ?? 'W';
  const divisor = unit === 'W' || unit === 'Wh' ? 1000 : 1;

  const seriesData = useMemo(
    () =>
      powerSeries.values.map((v) => ({
        x: new Date(v.timestamp).getTime(),
        y: Number(v.value) / divisor,
      })),
    [powerSeries.values, divisor],
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
          datetimeFormatter: {
            hour: 'HH:mm',
            minute: 'HH:mm',
          },
        },
      },
      yaxis: {
        title: { text: t('charts.kW') },
        labels: {
          formatter: (val: number) => val.toFixed(1),
        },
      },
      tooltip: {
        x: { format: 'MMM dd HH:mm' },
        y: {
          formatter: (val: number) => t('charts.powerValue', { value: val.toFixed(2) }),
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
    [isDark, t],
  );

  const series = useMemo(() => [{ name: t('charts.power'), data: seriesData }], [t, seriesData]);

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
