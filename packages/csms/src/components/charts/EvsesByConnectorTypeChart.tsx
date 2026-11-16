// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, escapeChartText, getGridColor } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { CHART_HEIGHT, ChartBody, type QueryState } from './ChartBody';
import { useConnectorTypeLabel } from '@/hooks/use-connector-type-label';

const ROW_HEIGHT_PX = 36;
const AXIS_HEIGHT_PX = 80;

/** Grows with the number of types so every bar keeps a readable row. */
export function connectorChartHeight(typeCount: number): number {
  return Math.max(CHART_HEIGHT, typeCount * ROW_HEIGHT_PX + AXIS_HEIGHT_PX);
}

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

  const typeLabel = useConnectorTypeLabel();
  // The axis and the tooltip show the shared display name ("CCS1", "J1772",
  // "Other" for the grouped `unknown`). An unknown vendor value is station
  // data, and ApexCharts writes the tooltip titles (the x formatter and the
  // axis tooltip category) as HTML, so the labels are escaped (security
  // review AI-L1, the case 306 rule).
  const labels = useMemo(
    () => data.map((d) => escapeChartText(typeLabel(d.connectorType))),
    [data, typeLabel],
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
      // Horizontal bars: each connector type name gets its own row on the
      // category axis, so full names never overlap however many types there
      // are or however narrow the card is.
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '60%' } },
      xaxis: {
        type: 'category',
        categories: labels,
        title: { text: t('dashboard.chartEvses') },
        labels: { formatter: (val: string) => formatNumber(Number(val), 0) },
      },
      yaxis: {
        labels: { maxWidth: 200 },
      },
      dataLabels: { enabled: false },
      tooltip: {
        x: {
          formatter: (val: number, opts?: { dataPointIndex?: number }) =>
            labels[opts?.dataPointIndex ?? -1] ?? String(val),
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
    }),
    [isDark, labels, data, t, i18n.language],
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
          <ReactApexChart
            options={options}
            series={series}
            type="bar"
            height={connectorChartHeight(data.length)}
          />
        </ChartBody>
      </CardContent>
    </Card>
  );
}
