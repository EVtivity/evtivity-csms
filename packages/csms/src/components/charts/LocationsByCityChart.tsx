// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { ChartBody, type QueryState } from './ChartBody';

interface CityCounts {
  siteCount: number;
  stationCount: number;
}

export interface LocationsByCityData {
  cities: Array<CityCounts & { city: string | null }>;
  other: CityCounts;
}

/** Stations per city (horizontal bars), sites in the tooltip. */
export function LocationsByCityChart({
  data,
  info,
  state,
}: {
  data: LocationsByCityData | undefined;
  info?: string | undefined;
  state?: QueryState | undefined;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';

  const rows = useMemo(() => {
    const list = (data?.cities ?? []).map((c) => ({
      label: c.city ?? t('dashboard.unknownCity'),
      siteCount: c.siteCount,
      stationCount: c.stationCount,
    }));
    if (data != null && data.other.siteCount > 0) {
      list.push({ label: t('dashboard.otherCities'), ...data.other });
    }
    return list;
  }, [data, t]);

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
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '60%' } },
      xaxis: {
        type: 'category',
        categories: rows.map((r) => r.label),
        labels: { formatter: (val: string) => formatNumber(Number(val), 0) },
      },
      yaxis: { labels: { maxWidth: 150 } },
      dataLabels: { enabled: false },
      tooltip: {
        y: {
          formatter: (val: number, opts?: { dataPointIndex?: number }) =>
            t('dashboard.cityTooltip', {
              stations: formatNumber(val, 0),
              sites: formatNumber(rows[opts?.dataPointIndex ?? -1]?.siteCount ?? 0, 0),
            }),
        },
      },
      colors: [CHART_COLORS.accent],
      responsive: [{ breakpoint: 768, options: { chart: { height: 250 } } }],
    }),
    [isDark, rows, t, i18n.language],
  );

  const series = useMemo(
    () => [{ name: t('dashboard.chartStations'), data: rows.map((r) => r.stationCount) }],
    [t, rows],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.locationsByCity')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartBody state={state} isEmpty={rows.length === 0} emptyText={t('dashboard.noLocations')}>
          <ReactApexChart options={options} series={series} type="bar" height={300} />
        </ChartBody>
      </CardContent>
    </Card>
  );
}
