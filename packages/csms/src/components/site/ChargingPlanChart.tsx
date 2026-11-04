// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The depot charging plan of the next 24 hours: the planned power of each
// vehicle stacked per slot, the site capacity as a reference line on the same
// kW axis, and the slots with a higher electricity price shaded behind the bars
// (a band, not a second axis). A vehicle past the seventh folds into "Other".

import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import {
  BAND_COLOR,
  CHART_SURFACE_COLOR,
  REFERENCE_LINE_COLOR,
  SERIES_COLORS,
  SERIES_OTHER_COLOR,
  escapeChartText,
  getGridColor,
} from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { formatDepotDateTime, formatDepotTime } from '@/lib/depot-time';

const HORIZON_MS = 24 * 3_600_000;
const SLOT_MS = 15 * 60_000;

export interface PlanChartEntry {
  departureId: string;
  powerKw: number[];
}

export interface PlanChartInput {
  slotStarts: readonly string[];
  plan: unknown;
  capacityKw: readonly unknown[] | null;
  pricePerKwh: readonly unknown[] | null;
}

export interface PlanChartData {
  /** Slot starts (epoch ms) inside the next 24 hours. */
  slots: number[];
  /** One series per vehicle (in plan order), then "Other" when more than the palette holds. */
  vehicles: Array<{ name: string; data: number[]; other: boolean }>;
  capacity: Array<number | null>;
  /** Slot ranges whose price is above the median of the shown slots. */
  highPrice: Array<{ from: number; to: number }>;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The stored plan entries the chart reads (departure and power per slot). */
export function planEntries(plan: unknown): PlanChartEntry[] {
  if (!Array.isArray(plan)) return [];
  const out: PlanChartEntry[] = [];
  for (const item of plan as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e['departureId'] !== 'string' || !Array.isArray(e['powerKw'])) continue;
    out.push({
      departureId: e['departureId'],
      powerKw: (e['powerKw'] as unknown[]).map((v) => num(v) ?? 0),
    });
  }
  return out;
}

/**
 * The chart data of a stored plan: the slots from now to 24 hours ahead, one
 * series per vehicle (labels from `labelOf`, past `maxSeries` summed into
 * "Other"), the capacity per slot and the higher-price slot ranges.
 */
export function buildPlanChartData(
  input: PlanChartInput,
  labelOf: (departureId: string, index: number) => string,
  otherLabel: string,
  nowMs: number,
  maxSeries: number = SERIES_COLORS.light.length,
): PlanChartData {
  const starts = input.slotStarts.map((s) => new Date(s).getTime());
  const indexes: number[] = [];
  starts.forEach((ms, i) => {
    if (Number.isFinite(ms) && ms + SLOT_MS > nowMs && ms < nowMs + HORIZON_MS) indexes.push(i);
  });
  const slots = indexes.map((i) => starts[i] ?? 0);
  const entries = planEntries(input.plan);
  const pick = (values: number[]): number[] => indexes.map((i) => values[i] ?? 0);
  const vehicles: PlanChartData['vehicles'] = [];
  const overflow = entries.length > maxSeries;
  const named = overflow ? entries.slice(0, maxSeries - 1) : entries;
  named.forEach((e, i) => {
    vehicles.push({ name: labelOf(e.departureId, i), data: pick(e.powerKw), other: false });
  });
  if (overflow) {
    const rest = entries.slice(maxSeries - 1);
    vehicles.push({
      name: otherLabel,
      data: indexes.map((i) => rest.reduce((sum, e) => sum + (e.powerKw[i] ?? 0), 0)),
      other: true,
    });
  }
  const capacity = indexes.map((i) => num(input.capacityKw?.[i]));
  const prices = indexes.map((i) => num(input.pricePerKwh?.[i]));
  const known = prices.filter((p): p is number => p != null).sort((a, b) => a - b);
  const highPrice: PlanChartData['highPrice'] = [];
  if (known.length > 0 && (known[known.length - 1] ?? 0) > (known[0] ?? 0)) {
    const median = known[Math.floor((known.length - 1) / 2)] ?? 0;
    prices.forEach((p, k) => {
      if (p == null || p <= median) return;
      const from = slots[k] ?? 0;
      const last = highPrice[highPrice.length - 1];
      if (last != null && last.to === from) last.to = from + SLOT_MS;
      else highPrice.push({ from, to: from + SLOT_MS });
    });
  }
  return { slots, vehicles, capacity, highPrice };
}

interface ChargingPlanChartProps {
  input: PlanChartInput;
  labelOf: (departureId: string, index: number) => string;
  timezone: string | null;
  nowMs: number;
}

export function ChargingPlanChart({
  input,
  labelOf,
  timezone,
  nowMs,
}: ChargingPlanChartProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const mode = isDark ? 'dark' : 'light';
  const data = useMemo(
    () => buildPlanChartData(input, labelOf, t('sites.fleetReadiness.otherVehicles'), nowMs),
    [input, labelOf, t, nowMs],
  );

  const series = useMemo<NonNullable<ApexOptions['series']>>(
    () => [
      ...data.vehicles.map((v) => ({
        // Vehicle labels are operator or CSV text; ApexCharts writes names as HTML.
        name: escapeChartText(v.name),
        type: 'bar',
        data: v.data.map((y, k) => ({ x: data.slots[k] ?? 0, y })),
      })),
      {
        name: t('sites.fleetReadiness.siteCapacity'),
        type: 'line',
        data: data.capacity.map((y, k) => ({ x: data.slots[k] ?? 0, y })),
      },
    ],
    [data, t],
  );

  const colors = useMemo(
    () => [
      ...data.vehicles.map((v, i) =>
        v.other ? SERIES_OTHER_COLOR[mode] : (SERIES_COLORS[mode][i] ?? SERIES_OTHER_COLOR[mode]),
      ),
      REFERENCE_LINE_COLOR[mode],
    ],
    [data, mode],
  );

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'bar',
        stacked: true,
        stackOnlyBar: true,
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        background: 'transparent',
        animations: { enabled: false },
      },
      theme: { mode },
      colors,
      // A 2px surface gap between stacked segments; the capacity line 2px and dashed.
      stroke: {
        width: [...data.vehicles.map(() => 2), 2],
        colors: [...data.vehicles.map(() => CHART_SURFACE_COLOR[mode]), colors.at(-1) ?? ''],
        dashArray: [...data.vehicles.map(() => 0), 6],
        curve: 'stepline',
      },
      plotOptions: {
        bar: { columnWidth: '90%', borderRadius: 4, borderRadiusApplication: 'end' },
      },
      dataLabels: { enabled: false },
      grid: { borderColor: getGridColor(isDark), strokeDashArray: 4 },
      legend: { show: true, position: 'bottom', horizontalAlign: 'left' },
      markers: { size: 0 },
      annotations: {
        xaxis: data.highPrice.map((band) => ({
          x: band.from,
          x2: band.to,
          fillColor: BAND_COLOR[mode],
          opacity: 0.15,
          borderColor: 'transparent',
        })),
      },
      xaxis: {
        type: 'datetime',
        labels: {
          datetimeUTC: false,
          formatter: (_value: string, timestamp?: number) =>
            timestamp == null ? '' : formatDepotTime(new Date(timestamp).toISOString(), timezone),
        },
      },
      yaxis: {
        min: 0,
        title: { text: t('charts.kW') },
        labels: { formatter: (val: number) => formatNumber(val, 0) },
      },
      tooltip: {
        shared: true,
        intersect: false,
        x: {
          formatter: (val: number) => formatDepotDateTime(new Date(val).toISOString(), timezone),
        },
        y: {
          formatter: (val: number | null) =>
            val == null ? '-' : t('charts.powerValue', { value: formatNumber(val, 1) }),
        },
      },
    }),
    [colors, data, isDark, mode, t, timezone, i18n.language],
  );

  if (data.slots.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground" data-testid="plan-chart-empty">
        {t('sites.fleetReadiness.noPlan')}
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="charging-plan-chart">
      <ReactApexChart options={options} series={series} type="bar" height={300} />
      {data.highPrice.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('sites.fleetReadiness.priceBandNote')}</p>
      )}
    </div>
  );
}
