// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys, TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import { SIM_RANGE_MAX_DAYS, SIM_REFRESH_DAY_OPTIONS } from '@evtivity/lib/sim-settings';
import { zonedMidnight } from '@evtivity/lib/timezone';
import { api, ApiError, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';

export const DAY_MS = 86_400_000;

export type SimState =
  | 'active'
  | 'pending'
  | 'suspended'
  | 'inactive'
  | 'deactivated'
  | 'test'
  | 'unknown';

export type SimStatusReason =
  | 'no_iccid'
  | 'no_provider_configured'
  | 'not_looked_up'
  | 'not_found'
  | 'sim_matched_elsewhere';

export interface SimCapabilities {
  networkName: boolean;
  radioAccessTechnology: boolean;
  cellId: boolean;
  usage: boolean;
  sessions: boolean;
  alerts: boolean;
  networkReset: boolean;
}

export interface SimUsage {
  bytes: number;
  periodEnd: string | null;
  limitBytes: number | null;
}

export type SignalGrade = 'good' | 'fair' | 'poor' | 'unknown';

export interface StationDataLink {
  instance: string | null;
  values: Record<string, string | null>;
  signalUnit: string | null;
  signal: {
    value: number;
    unit: 'dBm' | 'ASU';
    inferred: boolean;
    dbm: number | null;
    grade: SignalGrade;
  } | null;
}

/** What the station reported about its cellular modem (null while station signal reads are off). */
export interface StationSignal {
  protocol: 'ocpp2x' | 'ocpp1.6';
  deviceModel: 'unread' | 'no_datalink' | 'ok' | null;
  readAt: string | null;
  values: Record<string, string | null>;
  dataLinks: StationDataLink[];
  activeNetworkProfile: string | null;
  thresholds: { goodDbm: number; fairDbm: number };
}

/** Plain labels of the DataLink variables, in display order. */
export const DATALINK_LABEL_KEYS = {
  SignalStrength: 'stations.sim.station.signalStrength',
  Active: 'stations.sim.station.active',
  Enabled: 'stations.sim.station.enabled',
  Fallback: 'stations.sim.station.fallback',
  Problem: 'stations.sim.station.problem',
  NetworkAddress: 'stations.sim.station.networkAddress',
  ICCID: 'stations.sim.station.iccid',
  IMSI: 'stations.sim.station.imsi',
} as const;

export function signalGradeVariant(grade: SignalGrade): BadgeVariant {
  switch (grade) {
    case 'good':
      return 'success';
    case 'fair':
      return 'warning';
    case 'poor':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** `GET /v1/stations/:id/sim`: what the last Refresh stored. */
export interface StationSimStatus {
  provider: string | null;
  reason: SimStatusReason | null;
  capabilities: SimCapabilities | null;
  status: {
    state: SimState;
    providerState: string;
    inSession: boolean | null;
    openSessionBeganAt: string | null;
    apn: string | null;
    profileName: string | null;
    lastSessionAt: string | null;
    usage: SimUsage | null;
  } | null;
  statusFetchedAt: string | null;
  network: {
    name: string | null;
    radioAccessTechnology: string | null;
    cellId: string | null;
    observedAt: string;
  } | null;
  /**
   * The SIM match. Until it is confirmed nothing is fetched from the provider;
   * `iccidSource` says whether the station reported the ICCID or a user entered it.
   */
  match: {
    confirmed: boolean;
    confirmedAt: string | null;
    /** When the SIM was matched; Confirm SIM sends it back, so only the match shown is confirmed. */
    matchedAt: string | null;
    iccidSource: 'station' | 'entered';
    enteredBy: { id: string; name: string | null } | null;
  } | null;
  lastFetchedAt: string | null;
  /** The five newest stored SIM alerts (absent from older replies). */
  recentAlerts?: Array<{ kind: string; receivedAt: string }>;
  station: StationSignal | null;
  /** The time zone the coverage days are counted in: the station's site, else the system one. */
  coverageTimeZone: string;
  historyDays: number | null;
  reportingDelayHours: number | null;
  fetchDays: number;
  retentionDays: number;
}

export type CoverageLabel =
  | 'has_data'
  | 'no_sessions'
  | 'partial'
  | 'pending'
  | 'not_fetched'
  | 'unavailable';

export const COVERAGE_LABELS: readonly CoverageLabel[] = [
  'has_data',
  'no_sessions',
  'partial',
  'pending',
  'not_fetched',
  'unavailable',
];

export interface CoverageDay {
  /** Calendar date in the station time zone, YYYY-MM-DD. */
  date: string;
  label: CoverageLabel;
}

export interface SimTimelineItem {
  at: string;
  source: 'ocpp' | 'sim';
  kind: string;
  details: Record<string, unknown>;
}

/** `GET /v1/stations/:id/sim/timeline`. */
export interface SimTimelinePage {
  items: SimTimelineItem[];
  nextCursor: string | null;
  from: string;
  to: string;
  capped: boolean;
  lastFetchedAt: string | null;
  days: CoverageDay[];
}

interface RefreshPart {
  result: 'ok' | 'skipped' | 'failed';
  reason?: string;
  matchReason?: string;
  kind?: string;
  sessionsStored?: number;
  alertsStored?: number;
  retryAfter?: number;
  readAt?: string;
}

/** `POST /v1/stations/:id/sim/refresh`. */
export interface SimRefreshResult {
  provider: RefreshPart;
  station: RefreshPart;
}

export type SimRefreshBody =
  | { days: number; retryLookup?: boolean }
  | { from: string; to: string; retryLookup?: boolean };

/** Query key prefix of every SIM read of a station (status and timeline). */
export function stationSimKey(stationId: string): readonly unknown[] {
  return ['station-sim', stationId];
}

/**
 * The stored SIM status. Opening the tab reads the database only, and nothing
 * refetches it on a timer or on window focus: only a Refresh, a reset or
 * Confirm SIM does. While both SIM switches are off the API answers 400
 * SIM_FEATURE_DISABLED, and the station page hides everything SIM related.
 */
export function useStationSim(stationId: string) {
  return useQuery({
    queryKey: [...stationSimKey(stationId), 'status'],
    queryFn: () => api.get<StationSimStatus>(`/v1/stations/${stationId}/sim`),
    enabled: stationId !== '',
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}

export type PeriodBlock = 'history' | 'retention' | null;

export interface PeriodOption {
  days: number;
  blockedBy: PeriodBlock;
}

/**
 * The Refresh periods: 1, 3, 7, 14 and 31 days plus the configured default,
 * each blocked when it reaches past the provider's history window or the retention.
 */
export function periodOptions(
  status: Pick<StationSimStatus, 'fetchDays' | 'historyDays' | 'retentionDays'>,
): PeriodOption[] {
  const days = [...new Set([...SIM_REFRESH_DAY_OPTIONS, status.fetchDays])].sort((a, b) => a - b);
  return days.map((d) => ({
    days: d,
    blockedBy:
      status.historyDays != null && d > status.historyDays
        ? 'history'
        : d > status.retentionDays
          ? 'retention'
          : null,
  }));
}

/** The preselected period: the default while it is offered, else the largest open period. */
export function initialPeriod(options: PeriodOption[], fetchDays: number): number {
  const open = options.filter((o) => o.blockedBy == null);
  if (open.some((o) => o.days === fetchDays)) return fetchDays;
  return open.at(-1)?.days ?? fetchDays;
}

/** The chosen period while it is still open, else the preselected one (the window or retention shrank). */
export function selectedPeriod(options: PeriodOption[], chosen: number, fetchDays: number): number {
  if (options.some((o) => o.days === chosen && o.blockedBy == null)) return chosen;
  return initialPeriod(options, fetchDays);
}

/** Seconds to wait from a SIM 429 `SIM_PROVIDER_RATE_LIMITED` reply, or null for any other error. */
export function simRateLimitWait(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  if (getApiErrorCode(err) !== 'SIM_PROVIDER_RATE_LIMITED') return null;
  const body = err.body as { retryAfter?: unknown };
  return typeof body.retryAfter === 'number' && body.retryAfter > 0
    ? Math.ceil(body.retryAfter)
    : null;
}

/** The text of a failed SIM request: the wait of a rate limit, else the translated error. */
export function simErrorMessage(err: unknown, t: TFunction, fallbackKey?: ParseKeys): string {
  const wait = simRateLimitWait(err);
  if (wait != null) return t('stations.sim.rateLimitedRetry', { seconds: wait });
  return getErrorMessage(err, t, fallbackKey);
}

/** How many days back a custom range may start: the shorter of the history window and the retention. */
export function rangeWindowDays(
  status: Pick<StationSimStatus, 'historyDays' | 'retentionDays'>,
): number {
  return Math.min(status.historyDays ?? status.retentionDays, status.retentionDays);
}

export type BadgeVariant = 'success' | 'warning' | 'destructive' | 'info' | 'outline';

export function stateBadgeVariant(state: SimState): BadgeVariant {
  switch (state) {
    case 'active':
      return 'success';
    case 'pending':
    case 'suspended':
      return 'warning';
    case 'inactive':
    case 'deactivated':
      return 'destructive';
    case 'test':
      return 'info';
    default:
      return 'outline';
  }
}

/** Runs of consecutive Not Fetched days, oldest first. */
export function notFetchedRuns(days: CoverageDay[]): Array<{ from: string; to: string }> {
  const runs: Array<{ from: string; to: string }> = [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (day.label !== 'not_fetched') continue;
    if (last != null && nextDate(last.to) === day.date) last.to = day.date;
    else runs.push({ from: day.date, to: day.date });
  }
  return runs;
}

/** YYYY-MM-DD of the next calendar day. */
export function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD of an instant in a time zone. */
export function zonedDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const value = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Midnight at the start of a YYYY-MM-DD day in a time zone. */
export function dayStart(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return zonedMidnight(y ?? 1970, m ?? 1, d ?? 1, timeZone);
}

export type RangeError = 'required' | 'reversed' | 'tooLong' | 'beforeWindow' | 'inFuture' | null;

/**
 * Checks a custom range of whole days and gives the instants a Refresh sends:
 * from the first day's midnight (no earlier than the window allows) to the end
 * of the last day, never later than now.
 */
export function customRange(
  fromDate: string,
  toDate: string,
  timeZone: string,
  windowDays: number,
  now: Date,
): { error: RangeError; from: Date | null; to: Date | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { error: 'required', from: null, to: null };
  }
  const today = zonedDate(now, timeZone);
  if (toDate > today) return { error: 'inFuture', from: null, to: null };
  if (fromDate > toDate) return { error: 'reversed', from: null, to: null };
  const earliest = zonedDate(new Date(now.getTime() - windowDays * DAY_MS), timeZone);
  if (fromDate < earliest) return { error: 'beforeWindow', from: null, to: null };
  const start = dayStart(fromDate, timeZone);
  const end = dayStart(nextDate(toDate), timeZone);
  if (end.getTime() - start.getTime() > SIM_RANGE_MAX_DAYS * DAY_MS + DAY_MS / 24) {
    return { error: 'tooLong', from: null, to: null };
  }
  // A minute inside the window, so the provider and the retention bounds still hold at the API.
  const windowStart = now.getTime() - windowDays * DAY_MS + 60_000;
  return {
    error: null,
    from: new Date(Math.max(start.getTime(), windowStart)),
    to: new Date(Math.min(end.getTime(), now.getTime())),
  };
}

/** Bytes as B, KB, MB or GB in the UI language. */
export function formatDataBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 ** 2) return `${formatNumber(bytes / 1024, 1)} KB`;
  if (bytes < 1024 ** 3) return `${formatNumber(bytes / 1024 ** 2, 1)} MB`;
  return `${formatNumber(bytes / 1024 ** 3, 2)} GB`;
}

/** True when the usage this period passed 80 percent of a limit the provider reports. */
export function usageNearLimit(usage: SimUsage | null): boolean {
  if (usage == null || usage.limitBytes == null || usage.limitBytes <= 0) return false;
  return usage.bytes > usage.limitBytes * 0.8;
}

export const PROVIDER_NAMES: Readonly<Record<string, string>> = { hologram: 'Hologram' };

export function providerName(id: string | null): string {
  if (id == null) return '';
  return PROVIDER_NAMES[id] ?? id;
}

const PROVIDER_SKIP_REASONS = new Set(['provider_off', 'in_progress', 'not_confirmed']);
const MATCH_REASONS = new Set(['no_iccid', 'not_found', 'sim_matched_elsewhere']);
const PROVIDER_FAIL_KINDS = new Set([
  'auth',
  'not_found',
  'unsupported',
  'unavailable',
  'lock_lost',
]);
const STATION_SKIP_REASONS = new Set([
  'signal_off',
  'station_offline',
  'recent',
  'no_device_model',
  'no_keys',
  'not_operator_station',
]);
const STATION_FAIL_KINDS = new Set(['timeout', 'command_failed', 'unsupported', 'unavailable']);

/** The locale key part of an API reason or kind (`station_offline` is `stationOffline`). */
function known(set: Set<string>, value: string | undefined): string {
  if (value == null || !set.has(value)) return 'other';
  return value.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase());
}

export interface RefreshResultLine {
  key: string;
  values: Record<string, unknown>;
  /** Values that are plural texts of their own (`12 sessions`), translated with their count. */
  counts?: Record<string, { key: string; count: number }>;
}

/** The two result lines of a Refresh, as translation keys and values. */
export function refreshResultLines(result: SimRefreshResult): RefreshResultLine[] {
  const p = result.provider;
  const s = result.station;
  const providerLine: RefreshResultLine =
    p.result === 'ok'
      ? {
          key: 'stations.sim.result.providerOk',
          values: {},
          counts: {
            sessions: { key: 'stations.sim.result.sessionCount', count: p.sessionsStored ?? 0 },
            alerts: { key: 'stations.sim.result.alertCount', count: p.alertsStored ?? 0 },
          },
        }
      : p.result === 'skipped'
        ? p.reason === 'backoff'
          ? { key: 'stations.sim.result.providerBackoff', values: { seconds: p.retryAfter ?? 60 } }
          : p.reason === 'not_matched'
            ? {
                key: `stations.sim.result.providerNotMatched.${known(MATCH_REASONS, p.matchReason)}`,
                values: {},
              }
            : {
                key: `stations.sim.result.providerSkipped.${known(PROVIDER_SKIP_REASONS, p.reason)}`,
                values: {},
              }
        : p.kind === 'rate_limited'
          ? { key: 'stations.sim.result.providerBackoff', values: { seconds: p.retryAfter ?? 60 } }
          : {
              key: `stations.sim.result.providerFailed.${known(PROVIDER_FAIL_KINDS, p.kind)}`,
              values: {},
            };
  const stationLine =
    s.result === 'ok'
      ? { key: 'stations.sim.result.stationOk', values: {} }
      : s.result === 'skipped'
        ? {
            key: `stations.sim.result.stationSkipped.${known(STATION_SKIP_REASONS, s.reason)}`,
            values: {},
          }
        : {
            key: `stations.sim.result.stationFailed.${known(STATION_FAIL_KINDS, s.kind)}`,
            values: {},
          };
  return [providerLine, stationLine];
}

export type TimelineRowData =
  | { type: 'item'; key: string; item: SimTimelineItem }
  | { type: 'gap'; from: string; to: string };

/**
 * The timeline items, newest first, with one row per run of Not Fetched days
 * placed where its days fall, so an empty stretch never reads as a quiet SIM.
 * A run older than the last loaded item shows once every page is loaded.
 */
export function timelineRows(
  items: SimTimelineItem[],
  runs: Array<{ from: string; to: string }>,
  timezone: string,
  complete: boolean,
): TimelineRowData[] {
  const pending = [...runs].sort((a, b) => b.to.localeCompare(a.to));
  const rows: TimelineRowData[] = [];
  items.forEach((item, index) => {
    const day = zonedDate(new Date(item.at), timezone);
    let run = pending[0];
    while (run != null && run.to >= day) {
      rows.push({ type: 'gap', from: run.from, to: run.to });
      pending.shift();
      run = pending[0];
    }
    rows.push({
      type: 'item',
      key: `${item.source}-${item.kind}-${item.at}-${String(index)}`,
      item,
    });
  });
  if (complete) {
    for (const run of pending) rows.push({ type: 'gap', from: run.from, to: run.to });
  }
  return rows;
}
