// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  customRange,
  initialPeriod,
  simRateLimitWait,
  formatDataBytes,
  notFetchedRuns,
  periodOptions,
  rangeWindowDays,
  refreshResultLines,
  selectedPeriod,
  stateBadgeVariant,
  timelineRows,
  usageNearLimit,
  zonedDate,
} from '../sim-connectivity';

describe('periodOptions', () => {
  it('offers 1, 3, 7, 14 and 31 days', () => {
    expect(
      periodOptions({ fetchDays: 7, historyDays: 90, retentionDays: 90 }).map((o) => o.days),
    ).toEqual([1, 3, 7, 14, 31]);
  });

  it('adds a configured default that is not one of them', () => {
    expect(
      periodOptions({ fetchDays: 10, historyDays: 90, retentionDays: 90 }).map((o) => o.days),
    ).toEqual([1, 3, 7, 10, 14, 31]);
  });

  it('blocks periods beyond the history window, then beyond the retention', () => {
    const options = periodOptions({ fetchDays: 7, historyDays: 10, retentionDays: 20 });
    expect(options.map((o) => o.blockedBy)).toEqual([null, null, null, 'history', 'history']);
    const retention = periodOptions({ fetchDays: 7, historyDays: null, retentionDays: 7 });
    expect(retention.map((o) => o.blockedBy)).toEqual([null, null, null, 'retention', 'retention']);
  });

  it('starts a custom range no earlier than the shorter of both windows', () => {
    expect(rangeWindowDays({ historyDays: 90, retentionDays: 30 })).toBe(30);
    expect(rangeWindowDays({ historyDays: 60, retentionDays: 365 })).toBe(60);
    expect(rangeWindowDays({ historyDays: null, retentionDays: 45 })).toBe(45);
  });
});

describe('customRange', () => {
  const now = new Date('2026-10-22T15:00:00Z');

  it('covers whole days in the time zone, ending at now', () => {
    const range = customRange('2026-10-20', '2026-10-22', 'America/New_York', 90, now);
    expect(range.error).toBeNull();
    expect(range.from?.toISOString()).toBe('2026-10-20T04:00:00.000Z');
    expect(range.to?.toISOString()).toBe(now.toISOString());
  });

  it('refuses a missing, reversed, future, too long or too old range', () => {
    expect(customRange('', '2026-10-20', 'UTC', 90, now).error).toBe('required');
    expect(customRange('2026-10-21', '2026-10-20', 'UTC', 90, now).error).toBe('reversed');
    expect(customRange('2026-10-21', '2026-10-23', 'UTC', 90, now).error).toBe('inFuture');
    expect(customRange('2026-09-01', '2026-10-02', 'UTC', 90, now).error).toBe('tooLong');
    expect(customRange('2026-09-01', '2026-10-01', 'UTC', 90, now).error).toBeNull();
    expect(customRange('2026-07-01', '2026-07-10', 'UTC', 90, now).error).toBe('beforeWindow');
  });

  it('starts inside the window when the first day begins before it', () => {
    const range = customRange('2026-09-22', '2026-09-23', 'UTC', 30, now);
    expect(range.error).toBeNull();
    expect(range.from?.getTime()).toBeGreaterThan(now.getTime() - 30 * 86_400_000);
  });
});

describe('notFetchedRuns', () => {
  it('joins consecutive Not Fetched days', () => {
    expect(
      notFetchedRuns([
        { date: '2026-10-05', label: 'not_fetched' },
        { date: '2026-10-01', label: 'not_fetched' },
        { date: '2026-10-02', label: 'not_fetched' },
        { date: '2026-10-03', label: 'has_data' },
        { date: '2026-10-04', label: 'not_fetched' },
      ]),
    ).toEqual([
      { from: '2026-10-01', to: '2026-10-02' },
      { from: '2026-10-04', to: '2026-10-05' },
    ]);
  });
});

describe('timelineRows', () => {
  const item = (at: string) => ({ at, source: 'ocpp' as const, kind: 'connected', details: {} });

  it('places a gap row where its days fall, newest first', () => {
    const rows = timelineRows(
      [item('2026-10-10T10:00:00Z'), item('2026-10-04T10:00:00Z')],
      [{ from: '2026-10-06', to: '2026-10-08' }],
      'UTC',
      true,
    );
    expect(rows.map((r) => r.type)).toEqual(['item', 'gap', 'item']);
  });

  it('holds a gap older than the loaded items until every page is loaded', () => {
    const runs = [{ from: '2026-10-01', to: '2026-10-02' }];
    expect(timelineRows([item('2026-10-10T10:00:00Z')], runs, 'UTC', false)).toHaveLength(1);
    expect(timelineRows([item('2026-10-10T10:00:00Z')], runs, 'UTC', true)).toHaveLength(2);
  });
});

describe('refreshResultLines', () => {
  it('reports stored counts and a read signal', () => {
    expect(
      refreshResultLines({
        provider: { result: 'ok', sessionsStored: 12, alertsStored: 1 },
        station: { result: 'ok' },
      }),
    ).toEqual([
      {
        key: 'stations.sim.result.providerOk',
        values: {},
        counts: {
          sessions: { key: 'stations.sim.result.sessionCount', count: 12 },
          alerts: { key: 'stations.sim.result.alertCount', count: 1 },
        },
      },
      { key: 'stations.sim.result.stationOk', values: {} },
    ]);
  });

  it('names each skip reason and failure kind, and the wait of a backoff', () => {
    const line = (provider: Record<string, unknown>, station: Record<string, unknown>) =>
      refreshResultLines({
        provider: provider as never,
        station: station as never,
      }).map((l) => l.key);
    expect(
      line(
        { result: 'skipped', reason: 'provider_off' },
        { result: 'skipped', reason: 'signal_off' },
      ),
    ).toEqual([
      'stations.sim.result.providerSkipped.providerOff',
      'stations.sim.result.stationSkipped.signalOff',
    ]);
    expect(
      line(
        { result: 'skipped', reason: 'not_matched' },
        { result: 'skipped', reason: 'station_offline' },
      ),
    ).toEqual([
      'stations.sim.result.providerNotMatched.other',
      'stations.sim.result.stationSkipped.stationOffline',
    ]);
    for (const [matchReason, key] of [
      ['no_iccid', 'noIccid'],
      ['not_found', 'notFound'],
      ['sim_matched_elsewhere', 'simMatchedElsewhere'],
      ['surprise', 'other'],
    ]) {
      expect(
        line({ result: 'skipped', reason: 'not_matched', matchReason }, { result: 'ok' })[0],
      ).toBe(`stations.sim.result.providerNotMatched.${String(key)}`);
    }
    expect(
      line(
        { result: 'skipped', reason: 'not_confirmed', provider: 'hologram' },
        { result: 'skipped', reason: 'not_operator_station' },
      ),
    ).toEqual([
      'stations.sim.result.providerSkipped.notConfirmed',
      'stations.sim.result.stationSkipped.notOperatorStation',
    ]);
    for (const [kind, key] of [
      ['timeout', 'timeout'],
      ['command_failed', 'commandFailed'],
      ['unsupported', 'unsupported'],
      ['unavailable', 'unavailable'],
    ]) {
      expect(line({ result: 'ok' }, { result: 'failed', kind })[1]).toBe(
        `stations.sim.result.stationFailed.${String(key)}`,
      );
    }
    expect(
      line({ result: 'skipped', reason: 'in_progress' }, { result: 'skipped', reason: 'recent' }),
    ).toEqual([
      'stations.sim.result.providerSkipped.inProgress',
      'stations.sim.result.stationSkipped.recent',
    ]);
    expect(
      line({ result: 'failed', kind: 'lock_lost' }, { result: 'skipped', reason: 'no_keys' }),
    ).toEqual([
      'stations.sim.result.providerFailed.lockLost',
      'stations.sim.result.stationSkipped.noKeys',
    ]);
    expect(
      line({ result: 'failed', kind: 'auth' }, { result: 'skipped', reason: 'no_device_model' }),
    ).toEqual([
      'stations.sim.result.providerFailed.auth',
      'stations.sim.result.stationSkipped.noDeviceModel',
    ]);
    expect(line({ result: 'failed', kind: 'surprise' }, { result: 'failed' })).toEqual([
      'stations.sim.result.providerFailed.other',
      'stations.sim.result.stationFailed.other',
    ]);
    expect(
      refreshResultLines({
        provider: { result: 'skipped', reason: 'backoff', retryAfter: 40 },
        station: { result: 'ok' },
      })[0],
    ).toEqual({ key: 'stations.sim.result.providerBackoff', values: { seconds: 40 } });
    expect(
      refreshResultLines({
        provider: { result: 'failed', kind: 'rate_limited', retryAfter: 12 },
        station: { result: 'ok' },
      })[0],
    ).toEqual({ key: 'stations.sim.result.providerBackoff', values: { seconds: 12 } });
  });
});

describe('small helpers', () => {
  it('maps each SIM state to a badge', () => {
    expect(stateBadgeVariant('active')).toBe('success');
    expect(stateBadgeVariant('pending')).toBe('warning');
    expect(stateBadgeVariant('suspended')).toBe('warning');
    expect(stateBadgeVariant('inactive')).toBe('destructive');
    expect(stateBadgeVariant('deactivated')).toBe('destructive');
    expect(stateBadgeVariant('test')).toBe('info');
    expect(stateBadgeVariant('unknown')).toBe('outline');
  });

  it('warns above 80 percent only when the provider reports a limit', () => {
    expect(usageNearLimit({ bytes: 81, periodEnd: null, limitBytes: 100 })).toBe(true);
    expect(usageNearLimit({ bytes: 80, periodEnd: null, limitBytes: 100 })).toBe(false);
    expect(usageNearLimit({ bytes: 10_000, periodEnd: null, limitBytes: null })).toBe(false);
    expect(usageNearLimit(null)).toBe(false);
  });

  it('formats data amounts up to GB', () => {
    expect(formatDataBytes(500)).toBe('500 B');
    expect(formatDataBytes(1536)).toBe('1.5 KB');
    expect(formatDataBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatDataBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('gives the calendar date in a time zone', () => {
    expect(zonedDate(new Date('2026-10-22T02:00:00Z'), 'America/New_York')).toBe('2026-10-21');
  });
});

describe('initialPeriod', () => {
  it('keeps the default while it is offered and clamps it to the largest open period', () => {
    const open = periodOptions({ fetchDays: 7, historyDays: 90, retentionDays: 90 });
    expect(initialPeriod(open, 7)).toBe(7);
    const capped = periodOptions({ fetchDays: 31, historyDays: 90, retentionDays: 14 });
    expect(initialPeriod(capped, 31)).toBe(14);
    const none = periodOptions({ fetchDays: 3, historyDays: 0, retentionDays: 90 });
    expect(initialPeriod(none, 3)).toBe(3);
  });
});

describe('selectedPeriod', () => {
  it('keeps a chosen open period and re-clamps one the window or retention no longer allows', () => {
    const open = periodOptions({ fetchDays: 7, historyDays: 90, retentionDays: 90 });
    expect(selectedPeriod(open, 31, 7)).toBe(31);
    const shorter = periodOptions({ fetchDays: 7, historyDays: 90, retentionDays: 14 });
    expect(selectedPeriod(shorter, 31, 7)).toBe(7);
    const history = periodOptions({ fetchDays: 31, historyDays: 10, retentionDays: 90 });
    expect(selectedPeriod(history, 31, 31)).toBe(7);
    expect(selectedPeriod(open, 5, 7)).toBe(7);
  });
});

describe('simRateLimitWait', () => {
  it('reads the wait of a SIM rate limit and nothing else', () => {
    const limited = (body: unknown) => new ApiError(429, body);
    expect(simRateLimitWait(limited({ code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 40 }))).toBe(
      40,
    );
    expect(simRateLimitWait(limited({ code: 'SIM_PROVIDER_RATE_LIMITED' }))).toBeNull();
    expect(simRateLimitWait(limited({ code: 'RATE_LIMITED', retryAfter: 40 }))).toBeNull();
    expect(simRateLimitWait(new ApiError(400, { code: 'VALIDATION_ERROR' }))).toBeNull();
    expect(simRateLimitWait(new Error('x'))).toBeNull();
  });
});
