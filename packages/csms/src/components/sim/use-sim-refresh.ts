// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getApiErrorCode } from '@/lib/api';
import {
  initialPeriod,
  periodOptions,
  rangeWindowDays,
  selectedPeriod,
  simSourceKey,
  simSourcePath,
  zonedDate,
  type PeriodOption,
  type SimRefreshBody,
  type SimRefreshResult,
  type SimSource,
} from './sim-connectivity';

export const TIMELINE_PRESETS = [1, 24, 168, 744] as const;
export type TimelinePreset = (typeof TIMELINE_PRESETS)[number];

/** The timeline window: a preset back from its anchor, or the range a Custom Range fetched. */
export type TimelineRange =
  | { kind: 'preset'; hours: TimelinePreset; anchor: number }
  | { kind: 'custom'; from: string; to: string };

/** What the Refresh controls need to know about the stored SIM data. */
export interface SimRefreshInfo {
  provider: string | null;
  fetchDays: number;
  historyDays: number | null;
  retentionDays: number;
  /** The time zone the coverage days are counted in. */
  coverageTimeZone: string;
}

/**
 * The Refresh state shared by the Refresh card, the timeline card and the
 * Custom Range dialog of a SIM source: the chosen period, the last result,
 * the timeline window and the open range dialog. A Refresh invalidates every
 * read of the source, so the status, the timeline and the coverage reload.
 */
export function useSimRefresh(source: SimSource, info: SimRefreshInfo) {
  const queryClient = useQueryClient();
  const options: PeriodOption[] = periodOptions(info);
  const [chosenDays, setDays] = useState(() => initialPeriod(options, info.fetchDays));
  // A reload can shorten the window or the retention; the select then falls back to an open period.
  const days = selectedPeriod(options, chosenDays, info.fetchDays);
  const [result, setResult] = useState<SimRefreshResult | null>(null);
  const [range, setRange] = useState<TimelineRange>({
    kind: 'preset',
    hours: 24,
    anchor: Date.now(),
  });
  const [dialog, setDialog] = useState<{ from: string; to: string } | null>(null);

  const refresh = useMutation({
    mutationFn: (body: SimRefreshBody) =>
      api.post<SimRefreshResult>(`${simSourcePath(source)}/refresh`, body),
    onMutate: () => {
      setResult(null);
    },
    onSuccess: (data, body) => {
      setResult(data);
      if ('from' in body) {
        setRange({ kind: 'custom', from: body.from, to: body.to });
        setDialog(null);
      } else {
        setRange((current) =>
          current.kind === 'preset' ? { ...current, anchor: Date.now() } : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: simSourceKey(source) });
    },
    onError: (err) => {
      // A SIM deactivated since the page loaded: reload it, so it shows as inactive.
      if (getApiErrorCode(err) === 'SIM_INACTIVE') {
        void queryClient.invalidateQueries({ queryKey: simSourceKey(source) });
      }
    },
  });

  return {
    source,
    info,
    options,
    days,
    setDays,
    result,
    range,
    setRange,
    dialog,
    refresh,
    windowDays: rangeWindowDays(info),
    today: zonedDate(new Date(), info.coverageTimeZone),
    refreshWithDays: (retryLookup = false): void => {
      refresh.mutate(retryLookup ? { days, retryLookup: true } : { days });
    },
    openDialog: (from: string, to: string): void => {
      refresh.reset();
      setDialog({ from, to });
    },
    closeDialog: (): void => {
      setDialog(null);
    },
  };
}

export type SimRefreshController = ReturnType<typeof useSimRefresh>;
