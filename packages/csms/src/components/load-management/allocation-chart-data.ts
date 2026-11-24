// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';

export type AllocationReplyState = 'accepted' | 'rejected' | 'not_sent' | 'no_reply' | 'pending';

/** One point of an allocation step series, as the series route returns it. */
export interface AllocationPoint {
  t: string;
  limitKw: number;
  reason: LoadAllocationReason;
  reply: AllocationReplyState;
}

export interface AllocationSeriesItem {
  key: string;
  scope: 'station' | 'evse';
  stationId: string | null;
  stationOcppId: string;
  unitName: string | null;
  evseNumber: number | null;
  points: AllocationPoint[];
}

export interface AllocationSeriesResponse {
  series: AllocationSeriesItem[];
  references: {
    siteLimitKw: number | null;
    panels: { id: string; name: string; kw: number }[];
    transformers: { id: string; name: string; kw: number }[];
  };
  truncated: boolean;
}

export interface ChartSeries {
  name: string;
  other: boolean;
  data: { x: number; y: number }[];
  /** The point behind each data index (null: the held value at the range end, or "Other"). */
  points: (AllocationPoint | null)[];
}

/** The label of a series: the station, then the unit, then the EVSE. */
export function seriesLabel(item: AllocationSeriesItem, evseLabel: (n: number) => string): string {
  const parts = [item.stationOcppId];
  if (item.unitName != null) parts.push(item.unitName);
  if (item.evseNumber != null) parts.push(evseLabel(item.evseNumber));
  return parts.join(' / ');
}

/** The step value of a series at `ms`: its last point at or before it, else null. */
function valueAt(points: readonly AllocationPoint[], ms: number): number | null {
  let value: number | null = null;
  for (const p of points) {
    if (new Date(p.t).getTime() > ms) break;
    value = p.limitKw;
  }
  return value;
}

/**
 * The chart series: one step line per station and EVSE series in route order,
 * each held to the range end; past `maxSeries` the rest are summed into one
 * "Other" step line.
 */
export function buildAllocationChartData(
  items: readonly AllocationSeriesItem[],
  endMs: number,
  labelOf: (item: AllocationSeriesItem) => string,
  otherLabel: string,
  maxSeries: number,
): ChartSeries[] {
  const toSeries = (item: AllocationSeriesItem): ChartSeries => {
    const data = item.points.map((p) => ({ x: new Date(p.t).getTime(), y: p.limitKw }));
    const points: (AllocationPoint | null)[] = [...item.points];
    const last = item.points.at(-1);
    if (last != null && new Date(last.t).getTime() < endMs) {
      data.push({ x: endMs, y: last.limitKw });
      points.push(null);
    }
    return { name: labelOf(item), other: false, data, points };
  };
  if (items.length <= maxSeries) return items.map(toSeries);
  const named = items.slice(0, maxSeries - 1).map(toSeries);
  const rest = items.slice(maxSeries - 1);
  const times = [
    ...new Set(rest.flatMap((item) => item.points.map((p) => new Date(p.t).getTime()))),
    endMs,
  ].sort((a, b) => a - b);
  const data = times.map((x) => ({
    x,
    y: rest.reduce((sum, item) => sum + (valueAt(item.points, x) ?? 0), 0),
  }));
  return [...named, { name: otherLabel, other: true, data, points: data.map(() => null) }];
}
