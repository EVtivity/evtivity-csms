// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { STATUS_COLORS } from '@/lib/chart-theme';

interface StationStatusChartProps {
  data: { status: string; count: number }[];
  info?: string;
}

export function StationStatusChart({ data, info }: StationStatusChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const labels: string[] = useMemo(
    () => data.map((d) => t(`status.${d.status}` as 'status.available', d.status)),
    [data, t],
  );
  const values = useMemo(() => data.map((d) => d.count), [data]);
  const colors = useMemo(() => data.map((d) => STATUS_COLORS[d.status] ?? '#6b7280'), [data]);

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'donut',
        fontFamily: 'inherit',
        background: 'transparent',
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      labels,
      colors,
      legend: { position: 'bottom' },
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 250 },
          },
        },
      ],
    }),
    [isDark, labels, colors],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('charts.stationStatus')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ReactApexChart options={options} series={values} type="donut" height={300} />
      </CardContent>
    </Card>
  );
}
