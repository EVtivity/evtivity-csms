// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Eraser, Pause, Play, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { CodeBlock } from '@/components/ai/CodeBlock';
import { StationCombobox, type StationSelection } from '@/components/station-combobox';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import {
  LIVE_OCPP_HISTORY,
  LIVE_OCPP_POLL_LIMIT,
  LIVE_OCPP_POLL_MS,
  liveOcppCursor,
  mergeLiveOcppLines,
  newestLineAt,
  type LiveOcppLine,
} from './live-ocpp-buffer';
import { summarizeOcppMessage } from './ocpp-message-summary';

/** Within this many px of the bottom the list follows new lines. */
const FOLLOW_SLACK_PX = 24;

/**
 * Whether the signed-in user may open the live OCPP window: the station OCPP
 * log permission, since the window shows the same messages.
 */
export function useCanViewLiveOcpp(): boolean {
  return useHasPermission('stations:read');
}

export function LiveOcppButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = t('sites.layoutView.liveOcpp.button');
  // Phones show the icon only: the label stays for screen readers and as the tooltip.
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="pointer-events-auto bg-card shadow-xs"
      aria-pressed={open}
      title={label}
      data-testid="live-ocpp-toggle"
      onClick={onToggle}
    >
      <Terminal className="h-4 w-4" aria-hidden="true" />
      <span className="max-sm:sr-only" data-testid="live-ocpp-toggle-label">
        {label}
      </span>
    </Button>
  );
}

function lineTime(at: string, timezone: string): string {
  return formatDateTime(at, timezone, {
    year: undefined,
    month: undefined,
    day: undefined,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function detailOf(line: LiveOcppLine): unknown {
  if (line.messageType === 4) {
    return {
      errorCode: line.errorCode,
      errorDescription: line.errorDescription,
      details: line.payload ?? {},
    };
  }
  return line.payload ?? {};
}

function LiveOcppRow({
  line,
  expanded,
  onToggle,
  timezone,
}: {
  line: LiveOcppLine;
  expanded: boolean;
  onToggle: () => void;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const detailId = useId();
  const summary = summarizeOcppMessage(line);
  const inbound = line.direction === 'inbound';
  const text = [
    ...summary.parts,
    ...(summary.powerKw != null ? [`${formatNumber(summary.powerKw, 1)} kW`] : []),
  ].join(' ');
  return (
    <li data-testid={`live-ocpp-line-${String(line.id)}`} data-dim={summary.dim || undefined}>
      <Button
        type="button"
        variant="ghost"
        size="row-sm"
        className="font-mono"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-2 whitespace-nowrap',
            summary.dim && 'text-muted-foreground',
            summary.error && 'text-destructive',
          )}
        >
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {lineTime(line.createdAt, timezone)}
          </span>
          <span className="shrink-0 font-semibold">{line.stationOcppId}</span>
          <span
            className={cn('shrink-0', inbound ? 'text-success' : 'text-link')}
            title={t(
              inbound
                ? 'sites.layoutView.liveOcpp.fromStation'
                : 'sites.layoutView.liveOcpp.toStation',
            )}
          >
            <span aria-hidden="true">{inbound ? '>' : '<'}</span>
            <span className="sr-only">
              {t(
                inbound
                  ? 'sites.layoutView.liveOcpp.fromStation'
                  : 'sites.layoutView.liveOcpp.toStation',
              )}
            </span>
          </span>
          <span className="shrink-0">
            {line.action ?? (line.messageType === 4 ? 'CALLERROR' : '')}
          </span>
          <span className="min-w-0 truncate">{text}</span>
        </span>
      </Button>
      {expanded && (
        <div id={detailId} className="w-0 min-w-full px-2" data-testid="live-ocpp-detail">
          <CodeBlock code={JSON.stringify(detailOf(line), null, 2)} language="JSON" bounded />
        </div>
      )}
    </li>
  );
}

interface LiveOcppWindowProps {
  siteId: string;
  /** The station picked in the 3D view: the window filters to it. */
  focusStation: StationSelection | null;
  onClose: () => void;
}

/**
 * The live OCPP messages of a site, terminal style: the stored, masked OCPP
 * message log of the site's stations, polled while the window is open and
 * not paused, the newest lines kept.
 */
export function LiveOcppWindow({
  siteId,
  focusStation,
  onClose,
}: LiveOcppWindowProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const titleId = useId();
  const filterId = useId();
  const [station, setStation] = useState<StationSelection | null>(focusStation);
  const [lines, setLines] = useState<LiveOcppLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const newestAt = useRef<string | null>(null);
  const hiddenUpToId = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const stationId = station?.id ?? null;

  useEffect(() => {
    if (focusStation != null) setStation(focusStation);
  }, [focusStation]);

  // A new site or station filter starts a fresh buffer with its history.
  useEffect(() => {
    setLines([]);
    setExpanded(new Set());
    setLoading(true);
    setFailed(false);
    setFollowing(true);
    newestAt.current = null;
    hiddenUpToId.current = 0;
  }, [siteId, stationId]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (!document.hidden) {
        const cursor = liveOcppCursor(newestAt.current);
        const params = new URLSearchParams({
          limit: String(cursor == null ? LIVE_OCPP_HISTORY : LIVE_OCPP_POLL_LIMIT),
        });
        if (cursor != null) params.set('after', cursor);
        if (stationId != null) params.set('stationId', stationId);
        try {
          const res = await api.get<{ data: LiveOcppLine[] }>(
            `/v1/sites/${siteId}/ocpp-messages?${params.toString()}`,
          );
          if (cancelled) return;
          newestAt.current = newestLineAt(newestAt.current, res.data);
          setLines((prev) =>
            mergeLiveOcppLines(prev, res.data, { hiddenUpToId: hiddenUpToId.current }),
          );
          setFailed(false);
        } catch (err: unknown) {
          if (cancelled) return;
          console.warn('Live OCPP messages failed to load, retrying', err);
          setFailed(true);
        }
        setLoading(false);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), LIVE_OCPP_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [siteId, stationId, paused]);

  useEffect(() => {
    const list = listRef.current;
    if (following && list != null) list.scrollTop = list.scrollHeight;
  }, [lines, following]);

  function onScroll(): void {
    const list = listRef.current;
    if (list == null) return;
    setFollowing(list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX);
  }

  function clear(): void {
    hiddenUpToId.current = lines.reduce((max, l) => Math.max(max, l.id), hiddenUpToId.current);
    setLines([]);
    setExpanded(new Set());
    setFollowing(true);
  }

  return (
    // The `dark` class gives the panel the dark theme tokens in both themes.
    <section
      aria-labelledby={titleId}
      data-testid="live-ocpp-window"
      className="dark pointer-events-auto absolute left-3 right-3 top-[5.5rem] z-[890] flex h-72 max-h-[calc(100%-6.5rem)] min-h-48 flex-col overflow-hidden rounded-lg border bg-background text-foreground shadow-lg sm:right-auto sm:h-80 sm:w-[38rem] sm:max-w-[calc(100%-1.5rem)] sm:resize"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
          <Terminal className="h-4 w-4" aria-hidden="true" />
          {t('sites.layoutView.liveOcpp.title')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('sites.layoutView.liveOcpp.close')}
          title={t('sites.layoutView.liveOcpp.close')}
          data-testid="live-ocpp-close"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Label htmlFor={filterId} className="sr-only">
          {t('sites.layoutView.liveOcpp.stationFilter')}
        </Label>
        <div className="min-w-40 flex-1">
          <StationCombobox id={filterId} siteId={siteId} value={station} onSelect={setStation} />
        </div>
        {station != null && (
          <Button
            type="button"
            variant="outline"
            data-testid="live-ocpp-all-stations"
            onClick={() => {
              setStation(null);
            }}
          >
            {t('sites.layoutView.liveOcpp.allStations')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          aria-pressed={paused}
          data-testid="live-ocpp-pause"
          onClick={() => {
            setPaused((p) => !p);
          }}
        >
          {paused ? (
            <Play className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Pause className="h-4 w-4" aria-hidden="true" />
          )}
          {t(paused ? 'sites.layoutView.liveOcpp.resume' : 'sites.layoutView.liveOcpp.pause')}
        </Button>
        <Button type="button" variant="outline" data-testid="live-ocpp-clear" onClick={clear}>
          <Eraser className="h-4 w-4" aria-hidden="true" />
          {t('sites.layoutView.liveOcpp.clear')}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <ol
          ref={listRef}
          onScroll={onScroll}
          aria-labelledby={titleId}
          data-testid="live-ocpp-lines"
          className="h-full overflow-y-auto overscroll-contain py-1 font-mono text-xs"
        >
          {lines.map((line) => (
            <LiveOcppRow
              key={line.id}
              line={line}
              timezone={timezone}
              expanded={expanded.has(line.id)}
              onToggle={() => {
                setFollowing(false);
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(line.id)) next.delete(line.id);
                  else next.add(line.id);
                  return next;
                });
              }}
            />
          ))}
        </ol>
        {lines.length === 0 && (
          <p
            className={cn(
              'pointer-events-none absolute inset-x-0 top-3 text-center text-xs',
              failed ? 'text-destructive' : 'text-muted-foreground',
            )}
            role={failed ? 'alert' : 'status'}
            data-testid="live-ocpp-state"
          >
            {failed
              ? t('sites.layoutView.liveOcpp.loadError')
              : loading
                ? t('sites.layoutView.liveOcpp.loading')
                : paused
                  ? t('sites.layoutView.liveOcpp.paused')
                  : t('sites.layoutView.liveOcpp.waiting')}
          </p>
        )}
        {!following && lines.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-2 right-2 shadow-md"
            data-testid="live-ocpp-follow"
            onClick={() => {
              setFollowing(true);
            }}
          >
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
            {t('sites.layoutView.liveOcpp.jumpToLatest')}
          </Button>
        )}
      </div>
      {paused && lines.length > 0 && (
        <p className="border-t px-3 py-1 text-xs text-muted-foreground" role="status">
          {t('sites.layoutView.liveOcpp.paused')}
        </p>
      )}
      {failed && lines.length > 0 && (
        <p className="border-t px-3 py-1 text-xs text-destructive" role="alert">
          {t('sites.layoutView.liveOcpp.loadError')}
        </p>
      )}
    </section>
  );
}
