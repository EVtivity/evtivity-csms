// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SnapshotData {
  hasData: boolean;
  totalStations: number;
  onlineStations: number;
  onlinePercent: number;
  uptimePercent: number;
  activeSessions: number;
  totalEnergyWh: number;
  dayEnergyWh: number;
  totalSessions: number;
  daySessions: number;
  connectedStations: number;
  totalRevenueCents: number;
  dayRevenueCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
  dayTransactions: number;
  totalPorts: number;
  stationsBelowThreshold: number;
  avgPingLatencyMs: number;
  pingSuccessRate: number;
}

export function computeDelta(
  current: number | undefined,
  baseline: number | undefined,
): number | null {
  if (current == null || baseline == null) return null;
  if (baseline !== 0) return Math.round(((current - baseline) / Math.abs(baseline)) * 1000) / 10;
  return current > 0 ? 100 : 0;
}

export interface DayDeltaContext {
  yd: SnapshotData | undefined;
  db: SnapshotData | undefined;
  dayDelta: (current: number | undefined, baseline: number | undefined) => number | null;
  deltaLabel: string;
}

export function useDayDeltaContext(): DayDeltaContext {
  const { yesterdayDate, dayBeforeDate } = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return {
      yesterdayDate: y.toISOString().split('T')[0] ?? '',
      dayBeforeDate: d2.toISOString().split('T')[0] ?? '',
    };
  })();

  const yesterdaySnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'yesterday', yesterdayDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${yesterdayDate}`),
    staleTime: 5 * 60_000,
  });

  const dayBeforeSnapshot = useQuery({
    queryKey: ['dashboard', 'snapshots', 'dayBefore', dayBeforeDate],
    queryFn: () => api.get<SnapshotData>(`/v1/dashboard/snapshots?date=${dayBeforeDate}`),
    staleTime: 5 * 60_000,
  });

  const yd = yesterdaySnapshot.data;
  const db = dayBeforeSnapshot.data;

  // Only show day-over-day delta when both reference days actually had snapshot
  // data. Otherwise StatCards used to show misleading +/-100% vs empty baseline
  // on the first 1-2 days after a fresh deployment.
  const dayDelta = (current: number | undefined, baseline: number | undefined): number | null =>
    yd?.hasData === true && db?.hasData === true ? computeDelta(current, baseline) : null;

  const deltaLabel = (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 2);
    return `${String(y.getMonth() + 1)}/${String(y.getDate())} vs ${String(d2.getMonth() + 1)}/${String(d2.getDate())}`;
  })();

  return { yd, db, dayDelta, deltaLabel };
}
