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
import { connectorTypeLabel, connectorTypeShortLabel } from './ConnectorStatus';

export interface EvsesByConnectorTypePoint {
  connectorType: string;
  evseCount: number;
  connectorCount: number;
}

/** EVSEs per connector type (bars), connectors in the tooltip. */
export function EvsesByConnectorTypeChart({
  data,
  info,
  state,
}: {
  data: EvsesByConnectorTypePoint[];
  info?: string | undefined;
  state?: QueryState | undefined;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';

  // The axis shows the short standard name ("CCS1"), so labels never rotate or
  // clip; the tooltip names the full type ("CCS1 (Combined Charging System 1)").
  const labels = useMemo(
    () =>
      data.map((d) =>
        d.connectorType === 'unknown'
          ? t('stations.connectorUnknown')
          : (connectorTypeShortLabel(d.connectorType) ?? d.connectorType),
      ),
    [data, t],
  );
  const fullLabels = useMemo(
    () =>
      data.map((d) =>
        d.connectorType === 'unknown'
          ? t('stations.connectorUnknown')
          : (connectorTypeLabel(d.connectorType) ?? d.connectorType),
      ),
    [data, t],
  );

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
      plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
      xaxis: {
        type: 'category',
        categories: labels,
        labels: { rotate: 0, hideOverlappingLabels: false, trim: false },
      },
      yaxis: {
        title: { text: t('dashboard.chartEvses') },
        labels: { formatter: (val: number) => formatNumber(val, 0) },
      },
      dataLabels: { enabled: false },
      tooltip: {
        x: {
          formatter: (val: number, opts?: { dataPointIndex?: number }) =>
            fullLabels[opts?.dataPointIndex ?? -1] ?? String(val),
        },
        y: {
          formatter: (val: number, opts?: { dataPointIndex?: number }) =>
            t('dashboard.connectorTypeTooltip', {
              evses: formatNumber(val, 0),
              connectors: formatNumber(data[opts?.dataPointIndex ?? -1]?.connectorCount ?? 0, 0),
            }),
        },
      },
      colors: [CHART_COLORS.secondary],
      responsive: [{ breakpoint: 768, options: { chart: { height: 250 } } }],
    }),
    [isDark, labels, fullLabels, data, t, i18n.language],
  );

  const series = useMemo(
    () => [{ name: t('dashboard.chartEvses'), data: data.map((d) => d.evseCount) }],
    [t, data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.evsesByConnectorType')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartBody state={state} isEmpty={data.length === 0} emptyText={t('dashboard.noEvses')}>
          <ReactApexChart options={options} series={series} type="bar" height={300} />
        </ChartBody>
      </CardContent>
    </Card>
  );
}
