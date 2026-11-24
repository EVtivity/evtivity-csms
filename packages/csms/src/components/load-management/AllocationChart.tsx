// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The limits load management sent at this site over a range, read from the
// allocation log: one step line per station limit and per EVSE limited on
// its own, the site limit as a reference line, the sessions and their tariffs
// below, and the CSV export of the same range.

import { useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import { ExportButton } from '@/components/export-button';
import { ChartBody } from '@/components/charts/ChartBody';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth, useHasPermission } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/config';
import { downloadApiFile } from '@/lib/csv-download';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import {
  REFERENCE_LINE_COLOR,
  SERIES_COLORS,
  SERIES_OTHER_COLOR,
  escapeChartText,
  getGridColor,
} from '@/lib/chart-theme';
import {
  buildAllocationChartData,
  seriesLabel,
  type AllocationPoint,
  type AllocationSeriesResponse,
} from './allocation-chart-data';
import { AllocationTimeline, type TimelinePart } from './AllocationTimeline';

const RANGES = { '6h': 6, '24h': 24, '7d': 168 } as const;
type RangeKey = keyof typeof RANGES;

interface AllocationChartProps {
  siteId: string;
  timezone: string;
}

/** The query range for a preset, ending at the current minute (stable within a minute). */
function rangeOf(key: RangeKey, nowMs: number): { from: string; to: string } {
  const to = Math.ceil(nowMs / 60_000) * 60_000;
  return {
    from: new Date(to - RANGES[key] * 3_600_000).toISOString(),
    to: new Date(to).toISOString(),
  };
}

export function AllocationChart({ siteId, timezone }: AllocationChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const mode = isDark ? 'dark' : 'light';
  const canReadSessions = useHasPermission('sessions:read');
  const [rangeKey, setRangeKey] = useState<RangeKey>('24h');
  const range = rangeOf(rangeKey, Date.now());
  const params = new URLSearchParams(range).toString();

  const seriesQuery = useQuery({
    queryKey: ['sites', siteId, 'load-management', 'allocations', 'series', range.from, range.to],
    queryFn: () =>
      api.get<AllocationSeriesResponse>(
        `/v1/sites/${siteId}/load-management/allocations/series?${params}`,
      ),
    staleTime: 10_000,
  });
  const timelineQuery = useQuery({
    queryKey: ['sites', siteId, 'load-management', 'allocations', 'sessions', range.from, range.to],
    queryFn: () =>
      api.get<{ parts: TimelinePart[] }>(
        `/v1/sites/${siteId}/load-management/allocations/sessions?${params}`,
      ),
    staleTime: 10_000,
    enabled: canReadSessions,
  });

  const endMs = new Date(range.to).getTime();
  const chartSeries = useMemo(
    () =>
      buildAllocationChartData(
        Array.isArray(seriesQuery.data?.series) ? seriesQuery.data.series : [],
        Math.min(endMs, Date.now()),
        (item) => seriesLabel(item, (n) => t('loadManagement.chart.evse', { number: n })),
        t('loadManagement.chart.other'),
        SERIES_COLORS.light.length,
      ),
    [seriesQuery.data, endMs, t],
  );
  // A reply of another shape (an older API) draws no reference line.
  const references = (seriesQuery.data as Partial<AllocationSeriesResponse> | undefined)
    ?.references;
  const siteLimitKw = references?.siteLimitKw ?? null;

  const options = useMemo<ApexOptions>(() => {
    const pointText = (point: AllocationPoint | null | undefined): string =>
      point == null
        ? ''
        : [
            t(`loadManagement.reasons.${point.reason}`),
            t(`loadManagement.replyStates.${point.reply}`),
          ].join(' · ');
    return {
      chart: {
        type: 'line',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        background: 'transparent',
        animations: { enabled: false },
      },
      theme: { mode },
      colors: chartSeries.map((s, i) =>
        s.other ? SERIES_OTHER_COLOR[mode] : (SERIES_COLORS[mode][i] ?? SERIES_OTHER_COLOR[mode]),
      ),
      stroke: { width: 2, curve: 'stepline' },
      markers: { size: 0 },
      dataLabels: { enabled: false },
      grid: { borderColor: getGridColor(isDark), strokeDashArray: 4 },
      legend: { show: true, position: 'bottom', horizontalAlign: 'left' },
      annotations: {
        yaxis:
          siteLimitKw != null
            ? [
                {
                  y: siteLimitKw,
                  borderColor: REFERENCE_LINE_COLOR[mode],
                  strokeDashArray: 6,
                  label: {
                    text: escapeChartText(
                      t('loadManagement.chart.siteLimit', { kw: formatNumber(siteLimitKw, 1) }),
                    ),
                  },
                },
              ]
            : [],
      },
      xaxis: {
        type: 'datetime',
        labels: {
          datetimeUTC: false,
          formatter: (_value: string, timestamp?: number) =>
            timestamp == null ? '' : formatDateTime(new Date(timestamp).toISOString(), timezone),
        },
      },
      yaxis: {
        min: 0,
        title: { text: t('charts.kW') },
        labels: { formatter: (val: number) => formatNumber(val, 0) },
      },
      tooltip: {
        shared: false,
        intersect: false,
        x: {
          formatter: (val: number) => formatDateTime(new Date(val).toISOString(), timezone),
        },
        y: {
          formatter: (
            val: number | null,
            opts?: { seriesIndex?: number; dataPointIndex?: number },
          ) => {
            if (val == null) return '-';
            const point = chartSeries[opts?.seriesIndex ?? -1]?.points[opts?.dataPointIndex ?? -1];
            const detail = pointText(point);
            const value = t('charts.powerValue', { value: formatNumber(val, 1) });
            // Reason and reply labels are translations, the series names user text.
            return escapeChartText(detail === '' ? value : `${value} (${detail})`);
          },
        },
      },
    };
  }, [chartSeries, isDark, mode, siteLimitKw, t, timezone]);

  const series = useMemo(
    () => chartSeries.map((s) => ({ name: escapeChartText(s.name), data: s.data })),
    [chartSeries],
  );

  return (
    <Card data-testid="allocation-chart">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('loadManagement.chart.title')}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t('loadManagement.chart.range')}
            className="w-auto"
            value={rangeKey}
            onChange={(e) => {
              setRangeKey(e.target.value as RangeKey);
            }}
          >
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <option key={key} value={key}>
                {t(`loadManagement.chart.ranges.${key}`)}
              </option>
            ))}
          </Select>
          <ExportButton
            label={t('loadManagement.chart.export')}
            onClick={() => {
              downloadApiFile(
                `${API_BASE_URL}/v1/sites/${siteId}/load-management/allocations/export?${params}`,
                `load-allocations-${siteId}.csv`,
              ).catch((err: unknown) => {
                toast({ title: getErrorMessage(err, t), variant: 'destructive' });
              });
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {seriesQuery.data?.truncated === true && (
          <Alert variant="info">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('loadManagement.chart.truncated')}</AlertDescription>
          </Alert>
        )}
        <ChartBody
          state={{
            isLoading: seriesQuery.isLoading,
            isError: seriesQuery.isError,
            onRetry: () => {
              void seriesQuery.refetch();
            },
          }}
          isEmpty={chartSeries.length === 0}
          emptyText={t('loadManagement.chart.empty')}
        >
          <div data-testid="allocation-chart-plot">
            <ReactApexChart options={options} series={series} type="line" height={300} />
          </div>
        </ChartBody>
        {canReadSessions && (
          <AllocationTimeline
            parts={Array.isArray(timelineQuery.data?.parts) ? timelineQuery.data.parts : []}
            timezone={timezone}
            isLoading={timelineQuery.isLoading}
            isError={timelineQuery.isError}
            onRetry={() => {
              void timelineQuery.refetch();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
