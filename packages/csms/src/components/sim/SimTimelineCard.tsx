// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/content-state';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatCalendarDate } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { DisabledWithReason } from './DisabledWithReason';
import { SimCoverageStrip } from './SimCoverageStrip';
import {
  formatDataBytes,
  notFetchedRuns,
  providerName,
  simSourceKey,
  simSourcePath,
  timelineRows,
  type SimTimelineItem,
  type SimTimelinePage,
} from './sim-connectivity';
import { TIMELINE_PRESETS, type SimRefreshController, type TimelineRange } from './use-sim-refresh';

/** Timeline entries per page. */
const TIMELINE_PAGE_SIZE = 25;

const PRESET_KEYS = {
  1: 'stations.sim.timelineLastHour',
  24: 'stations.sim.timelineLast24Hours',
  168: 'stations.sim.timelineLast7Days',
  744: 'stations.sim.timelineLast31Days',
} as const;

/** Labels of the timeline item kinds and of the stored SIM alerts. */
export const SIM_KIND_KEYS: Record<string, string> = {
  connected: 'stations.sim.kind.connected',
  disconnected: 'stations.sim.kind.disconnected',
  session: 'stations.sim.kind.session',
  data_limit: 'stations.sim.kind.dataLimit',
  data_warning: 'stations.sim.kind.dataWarning',
  device_changed: 'stations.sim.kind.deviceChanged',
  device_model_changed: 'stations.sim.kind.deviceModelChanged',
  first_device: 'stations.sim.kind.firstDevice',
  signal_low: 'stations.sim.kind.signalLow',
  signal_restored: 'stations.sim.kind.signalRestored',
};

const DISCONNECT_REASON_KEYS: Record<string, string> = {
  server_shutdown: 'stations.sim.disconnectReason.serverShutdown',
  offline_sweep: 'stations.sim.disconnectReason.offlineSweep',
};

const OFFLINE_CAUSE_KEYS: Record<string, string> = {
  server: 'stations.sim.offlineCause.server',
  sim_account: 'stations.sim.offlineCause.simAccount',
  station: 'stations.sim.offlineCause.station',
  network: 'stations.sim.offlineCause.network',
  pending: 'stations.sim.offlineCause.pending',
  unknown: 'stations.sim.offlineCause.unknown',
};

const OFFLINE_CAUSE_HINT_KEYS: Record<string, string> = {
  server: 'stations.sim.offlineCauseHint.server',
  sim_account: 'stations.sim.offlineCauseHint.simAccount',
  station: 'stations.sim.offlineCauseHint.station',
  network: 'stations.sim.offlineCauseHint.network',
  pending: 'stations.sim.offlineCauseHint.pending',
  unknown: 'stations.sim.offlineCauseHint.unknown',
};

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function rangeParams(range: TimelineRange): { from: string; to?: string } {
  if (range.kind === 'custom') return { from: range.from, to: range.to };
  return { from: new Date(range.anchor - range.hours * 3_600_000).toISOString() };
}

/**
 * The timeline of a SIM source: the window select, when the data was last
 * fetched, the coverage strip and the items, newest first, with a Fetch row
 * for each run of days not fetched yet, paged with the shared Pagination
 * (TIMELINE_PAGE_SIZE entries a page). Reads the database only. With
 * `disabledReason` (an inactive SIM) the Fetch rows and day clicks are
 * disabled and show that reason, as Refresh does.
 */
export function SimTimelineCard({
  controller,
  timezone,
  lastFetchedAt,
  reportingDelayHours,
  disabledReason = null,
  title,
}: {
  controller: SimRefreshController;
  timezone: string;
  lastFetchedAt: string | null;
  reportingDelayHours: number | null;
  disabledReason?: string | null;
  /** The card title; the SIM Sessions tab passes its tab label. */
  title?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { source, info, range } = controller;
  const coverageZone = info.coverageTimeZone;
  const onRangeChange = controller.setRange;
  const onFetchRange = controller.openDialog;
  const params = rangeParams(range);
  const rangeKey = `${params.from}|${params.to ?? ''}`;
  const [paged, setPaged] = useState({ rangeKey, page: 1 });
  // A new range starts again on its first page.
  const page = paged.rangeKey === rangeKey ? paged.page : 1;
  const timeline = useQuery({
    queryKey: [...simSourceKey(source), 'timeline', params.from, params.to ?? null, page],
    queryFn: () => {
      const query = new URLSearchParams({
        from: params.from,
        page: String(page),
        limit: String(TIMELINE_PAGE_SIZE),
      });
      if (params.to != null) query.set('to', params.to);
      return api.get<SimTimelinePage>(`${simSourcePath(source)}/timeline?${query.toString()}`);
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const data = timeline.data;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / TIMELINE_PAGE_SIZE));
  // Fewer entries than before (a shorter retention): go back to the last page.
  useEffect(() => {
    if (data != null && page > totalPages) setPaged({ rangeKey, page: totalPages });
  }, [data, page, totalPages, rangeKey]);
  const items = data?.items ?? [];
  const days = data?.days ?? [];
  const runs = notFetchedRuns(days);
  const rows = timelineRows(items, runs, coverageZone, {
    previousAt: data?.previousAt ?? null,
    last: page >= totalPages,
  });

  return (
    <TabPanel title={title ?? t('stations.sim.timelineTitle')} bodyClassName="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="sim-timeline-range">{t('stations.sim.timelineRange')}</Label>
        <Select
          id="sim-timeline-range"
          className="w-auto"
          value={range.kind === 'preset' ? String(range.hours) : 'custom'}
          onChange={(e) => {
            const hours = TIMELINE_PRESETS.find((h) => String(h) === e.target.value);
            if (hours != null) onRangeChange({ kind: 'preset', hours, anchor: Date.now() });
          }}
        >
          {TIMELINE_PRESETS.map((h) => (
            <option key={h} value={String(h)}>
              {t(PRESET_KEYS[h])}
            </option>
          ))}
          {range.kind === 'custom' && (
            <option value="custom">
              {t('stations.sim.timelineCustom', {
                from: formatDateTime(range.from, timezone),
                to: formatDateTime(range.to, timezone),
              })}
            </option>
          )}
        </Select>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {lastFetchedAt == null
            ? t('stations.sim.notFetchedYet')
            : t('stations.sim.lastFetched', {
                time: formatDateTime(lastFetchedAt, timezone),
              })}
        </p>
        {info.provider != null && reportingDelayHours != null && (
          <p className="flex items-start gap-1">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {t('stations.sim.reportingNote', {
              provider: providerName(info.provider),
              hours: reportingDelayHours,
            })}
          </p>
        )}
        {data?.capped === true && <p>{t('stations.sim.timelineCapped')}</p>}
      </div>

      {timeline.isLoading ? (
        <LoadingState />
      ) : timeline.isError ? (
        <ErrorState
          message={getErrorMessage(timeline.error, t, 'common.loadError')}
          onRetry={() => {
            void timeline.refetch();
          }}
        />
      ) : (
        <>
          {days.length > 0 && (
            <SimCoverageStrip
              days={days}
              disabledReason={disabledReason}
              onSelectDay={(date) => {
                onFetchRange(date, date);
              }}
            />
          )}
          {rows.length === 0 ? (
            <EmptyState>{t('stations.sim.timelineEmpty')}</EmptyState>
          ) : (
            <ul className="divide-y" data-testid="sim-timeline">
              {rows.map((row) =>
                row.type === 'gap' ? (
                  <li
                    key={`gap-${row.from}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                    data-testid="sim-timeline-gap"
                  >
                    <span className="text-sm text-muted-foreground">
                      {t('stations.simCoverage.notFetchedRange', {
                        from: formatCalendarDate(row.from),
                        to: formatCalendarDate(row.to),
                      })}
                    </span>
                    {disabledReason != null ? (
                      <DisabledWithReason reason={disabledReason}>
                        <Button variant="outline" disabled>
                          {t('stations.sim.fetch')}
                        </Button>
                      </DisabledWithReason>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => {
                          onFetchRange(row.from, row.to);
                        }}
                      >
                        {t('stations.sim.fetch')}
                      </Button>
                    )}
                  </li>
                ) : (
                  <TimelineRow key={row.key} item={row.item} timezone={timezone} />
                ),
              )}
            </ul>
          )}
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(next) => {
              setPaged({ rangeKey, page: next });
            }}
          />
        </>
      )}
    </TabPanel>
  );
}

function TimelineRow({
  item,
  timezone,
}: {
  item: SimTimelineItem;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const kindKey = SIM_KIND_KEYS[item.kind];
  const kind = kindKey != null ? t(kindKey as 'stations.sim.kind.session') : item.kind;
  const details: string[] = [];
  if (item.kind === 'session') {
    const ended = stringOf(item.details.endedAt);
    if (ended != null)
      details.push(t('stations.sim.sessionEnded', { time: formatDateTime(ended, timezone) }));
    if (typeof item.details.bytes === 'number') details.push(formatDataBytes(item.details.bytes));
    const network = stringOf(item.details.networkName);
    const rat = stringOf(item.details.radioAccessTechnology);
    if (network != null) details.push(rat != null ? `${network} (${rat})` : network);
    else if (rat != null) details.push(rat);
    const cell = stringOf(item.details.cellId);
    if (cell != null) details.push(t('stations.sim.cellIdValue', { cell }));
  }
  if (item.kind === 'signal_low' || item.kind === 'signal_restored') {
    const instance = stringOf(item.details.instance);
    const actual = stringOf(item.details.actualValue);
    if (actual != null) details.push(t('stations.sim.signalReading', { value: actual }));
    if (instance != null) details.push(t('stations.sim.station.modem', { instance }));
  }
  if (item.kind === 'disconnected') {
    const reasonKey = DISCONNECT_REASON_KEYS[stringOf(item.details.reason) ?? ''];
    if (reasonKey != null) details.push(t(reasonKey as 'stations.sim.kind.session'));
  }
  const cause = stringOf(item.details.offlineCause) ?? '';
  const causeKey = OFFLINE_CAUSE_KEYS[cause];
  const causeHintKey = OFFLINE_CAUSE_HINT_KEYS[cause];

  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 text-xs text-muted-foreground sm:w-44">
        {formatDateTime(item.at, timezone)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={item.source === 'sim' ? 'info' : 'secondary'}>
            {item.source === 'sim' ? t('stations.sim.sourceSim') : t('stations.sim.sourceOcpp')}
          </Badge>
          <span className="text-sm font-medium">{kind}</span>
          {causeKey != null && (
            <Badge variant="outline">{t(causeKey as 'stations.sim.kind.session')}</Badge>
          )}
        </span>
        {details.length > 0 && (
          <span className="wrap-anywhere text-xs text-muted-foreground">{details.join(', ')}</span>
        )}
        {causeHintKey != null && (
          <span className="text-xs text-muted-foreground" data-testid="offline-cause-hint">
            {t(causeHintKey as 'stations.sim.kind.session')}
          </span>
        )}
      </span>
    </li>
  );
}
