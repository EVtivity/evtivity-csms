// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { formatCalendarDate } from '@/lib/formatting';

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
  /** Money fields are null for a user without payments:read. */
  totalRevenueCents: number | null;
  dayRevenueCents: number | null;
  avgRevenueCentsPerSession: number | null;
  totalTransactions: number | null;
  dayTransactions: number | null;
  totalPorts: number;
  stationsBelowThreshold: number;
  avgPingLatencyMs: number;
  pingSuccessRate: number;
}

export interface DatedSnapshotData extends SnapshotData {
  date: string;
}

/** The two snapshot days the day-over-day arrows compare, as the API picks them. */
export interface DayOverDay {
  current: DatedSnapshotData;
  previous: DatedSnapshotData;
}

export function computeDelta(
  current: number | null | undefined,
  baseline: number | null | undefined,
): number | null {
  if (current == null || baseline == null) return null;
  if (baseline !== 0) return Math.round(((current - baseline) / Math.abs(baseline)) * 1000) / 10;
  return current > 0 ? 100 : 0;
}

export interface DayDeltaContext {
  yd: SnapshotData | undefined;
  db: SnapshotData | undefined;
  dayDelta: (
    current: number | null | undefined,
    baseline: number | null | undefined,
  ) => number | null;
  deltaLabel: string;
}

/**
 * The day-over-day comparison of the stat cards: the latest complete
 * snapshot day and the day before, picked by the API in the timezone the
 * snapshots use (never the browser's day), labelled with both dates in the
 * UI language.
 */
export function useDayDeltaContext(): DayDeltaContext {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['dashboard', 'snapshots', 'day-over-day'],
    queryFn: () => api.get<DayOverDay>('/v1/dashboard/snapshots/day-over-day'),
    staleTime: 5 * 60_000,
  });

  const yd = data?.current;
  const db = data?.previous;

  // Only show day-over-day delta when both reference days actually had snapshot
  // data. Otherwise StatCards used to show misleading +/-100% vs empty baseline
  // on the first 1-2 days after a fresh deployment.
  const dayDelta = (
    current: number | null | undefined,
    baseline: number | null | undefined,
  ): number | null =>
    yd?.hasData === true && db?.hasData === true ? computeDelta(current, baseline) : null;

  const deltaLabel =
    yd != null && db != null
      ? t('dashboard.deltaRange', {
          current: formatCalendarDate(yd.date),
          previous: formatCalendarDate(db.date),
        })
      : '';

  return { yd, db, dayDelta, deltaLabel };
}
