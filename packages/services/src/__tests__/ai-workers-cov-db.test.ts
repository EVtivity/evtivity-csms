// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The background AI worker reads and the run writer: run claims and their
// compare-and-set ends (P5, P7), stuck sessions, tariff findings, network
// metrics, long faulted stations, and the once-a-day proposal digest.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  dispatched: [] as {
    event: string;
    recipient: Record<string, unknown>;
    vars: Record<string, unknown>;
  }[],
  deliver: [] as (string[] | Error)[],
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { createFakeDb } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return {
    ...actual,
    client: h.fake.client,
    db: h.fake.db,
    getSystemTimezone: () => Promise.resolve('Europe/Berlin'),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchSystemNotification: (
      _client: unknown,
      event: string,
      recipient: Record<string, unknown>,
      vars: Record<string, unknown>,
    ) => {
      h.dispatched.push({ event, recipient, vars });
      const next = h.deliver.shift() ?? ['email'];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ delivered: next });
    },
  };
});

const runs = await import('../ai-workers/runs.js');
const stuck = await import('../ai-workers/stuck-sessions.js');
const tariff = await import('../ai-workers/tariff-anomalies.js');
const network = await import('../ai-workers/network-summary.js');
const digest = await import('../ai-workers/digest.js');

const silentLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  h.fake.reset();
  h.dispatched.length = 0;
  h.deliver.length = 0;
  silentLog.warn.mockClear();
});

describe('worker runs', () => {
  it('maps a site to its scope', () => {
    expect(runs.scopeOfSite('sit_1')).toBe('sit_1');
    expect(runs.scopeOfSite(null)).toBe(runs.UNSITED_SCOPE);
  });

  it('claims a run, or null when the period already ran', async () => {
    h.fake.queue('insert', [{ id: 12 }]);
    const input = { job: 'stuck_sessions' as const, scope: 'sit_1', siteId: 'sit_1', period: 'p' };
    expect(await runs.claimAiWorkerRun(input)).toBe(12);
    expect(await runs.claimAiWorkerRun(input)).toBeNull();
    const [first] = h.fake.find('insert');
    expect(first!.values).toMatchObject({
      job: 'stuck_sessions',
      scopeKey: 'sit_1',
      status: 'running',
    });
    expect(first!.set).toMatchObject({ status: 'running', error: null, proposalsCount: 0 });
  });

  it('finishes with defaults and cuts a long error to 1000 characters', async () => {
    await runs.finishAiWorkerRun(1, { status: 'completed' });
    expect(h.fake.calls[0]!.set).toMatchObject({
      status: 'completed',
      proposalsCount: 0,
      findingsCount: 0,
      insightId: null,
      output: null,
      error: null,
    });
    await runs.finishAiWorkerRun(2, {
      status: 'failed',
      proposalsCount: 2,
      findingsCount: 3,
      insightId: 'ain_1',
      output: { x: 1 },
      error: 'e'.repeat(1500),
    });
    const set = h.fake.calls[1]!.set as Record<string, unknown>;
    expect((set['error'] as string).length).toBe(1000);
    expect(set).toMatchObject({ proposalsCount: 2, findingsCount: 3, insightId: 'ain_1' });
  });

  it('fails stale runs and prunes old ones, returning the counts', async () => {
    h.fake.queue('update', [{ id: 1 }, { id: 2 }]);
    expect(await runs.failStaleAiWorkerRuns()).toBe(2);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(await runs.failStaleAiWorkerRuns(5)).toBe(0);
    h.fake.queue('delete', [{ id: 3 }]);
    expect(await runs.pruneAiWorkerRuns(30)).toBe(1);
  });
});

describe('findStuckSessions', () => {
  const base = {
    id: 'ses_1',
    station_id: 'sta_1',
    ocpp_station_id: 'CS-1',
    ocpp_protocol: 'ocpp2.1',
    ocpp_evse_id: 1,
    transaction_id: 'tx1',
    site_id: 'sit_1',
    energy_wh: '1500.5',
    current_cost_cents: 320,
    currency: 'USD',
    is_online: true,
    offline_since: null,
    connector_status: 'charging',
    started_at: null,
    last_activity_at: '2026-11-01T10:00:00Z',
  };

  it('maps rows and their reason', async () => {
    h.fake.queue('client:FROM charging_sessions s', [
      { ...base, is_online: false, offline_since: '2026-11-01T09:00:00Z' },
      { ...base, id: 'ses_2', connector_status: 'available', energy_wh: null },
      { ...base, id: 'ses_3' },
    ]);
    const out = await stuck.findStuckSessions({
      idleMinutes: 60,
      staleTimeoutHours: 4,
      siteId: 'sit_1',
    });
    expect(out.map((s) => s.reason)).toEqual([
      'station_offline',
      'connector_available',
      'no_activity',
    ]);
    expect(out[0]).toMatchObject({ energyWh: 1500.5, ocppStationId: 'CS-1', startedAt: null });
    expect(out[0]!.stationOfflineSince?.toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(out[1]!.energyWh).toBe(0);
    const [call] = h.fake.find('client', 'FROM charging_sessions s');
    expect(call!.text).toContain('cs.site_id = $');
    expect(call!.text).toContain('FROM transaction_events te');
    expect(call!.params).toEqual(expect.arrayContaining(['sit_1', 4, 60, 200]));
  });

  it('filters unsited stations, every site, and skips the cleanup filter when it is off', async () => {
    await stuck.findStuckSessions({
      idleMinutes: 30,
      staleTimeoutHours: 0,
      siteId: null,
      limit: 5,
    });
    const [unsited] = h.fake.find('client', 'FROM charging_sessions s');
    expect(unsited!.text).toContain('cs.site_id IS NULL');
    expect(unsited!.text).not.toContain('FROM transaction_events te');
    expect(unsited!.params).toContain(5);
    h.fake.queue('client:FROM charging_sessions s', [
      base,
      { ...base, id: 'b', site_id: null },
      { ...base, id: 'c' },
    ]);
    expect(await stuck.sitesWithStuckSessions({ idleMinutes: 30, staleTimeoutHours: 2 })).toEqual([
      'sit_1',
      null,
    ]);
    const all = h.fake.find('client', 'FROM charging_sessions s')[1]!;
    expect(all.text).not.toContain('cs.site_id = $');
    expect(all.params).toContain(5000);
  });

  it('clamps the idle time below the stale cleanup', () => {
    expect(stuck.effectiveIdleMinutes(5, 0)).toBe(stuck.SIGNAL_GRACE_MINUTES);
    expect(stuck.effectiveIdleMinutes(600, 0)).toBe(600);
    expect(stuck.effectiveIdleMinutes(600, 2)).toBe(60);
  });
});

describe('tariffAnomalies', () => {
  it('maps the findings and an empty sample', async () => {
    h.fake.queue('client:WITH window_sessions', [
      { type: 'zero_cost', count: 2, session_ids: ['a', 'b'] },
      { type: 'price_outlier', count: 1, session_ids: null },
    ]);
    const now = new Date('2026-11-01T00:00:00Z');
    expect(await tariff.tariffAnomalies({ siteId: 'sit_1', now })).toEqual([
      { type: 'zero_cost', count: 2, sessionIds: ['a', 'b'] },
      { type: 'price_outlier', count: 1, sessionIds: [] },
    ]);
    const [call] = h.fake.find('client', 'WITH window_sessions');
    expect(call!.params).toEqual(
      expect.arrayContaining([
        now,
        'sit_1',
        tariff.STATION_COST_TOLERANCE_CENTS,
        tariff.PRICE_OUTLIER_FACTOR,
      ]),
    );
  });
});

describe('network summary reads', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  it('maps site metrics with the prior daily average to one decimal', async () => {
    h.fake.queue('client:WITH bounds AS', [
      {
        site_id: 'sit_1',
        site_name: 'Depot',
        stations: 4,
        online: 3,
        offline: 1,
        faulted: 0,
        sessions_24h: 10,
        failed_24h: 1,
        refused_24h: 2,
        alerts_24h: 0,
        sessions_prior: 50,
        failed_prior: 3,
        refused_prior: 0,
        alerts_prior: 1,
      },
    ]);
    const [m] = await network.siteHealthMetrics({ now, siteId: 'sit_1' });
    expect(m).toMatchObject({
      siteId: 'sit_1',
      last24h: { sessions: 10, failedSessions: 1, refusedAuthorizations: 2, criticalAlerts: 0 },
      priorDailyAverage: {
        sessions: 7.1,
        failedSessions: 0.4,
        refusedAuthorizations: 0,
        criticalAlerts: 0.1,
      },
    });
    expect(network.hasActivity(m!)).toBe(true);
    expect(h.fake.find('client', 'WITH bounds AS')[0]!.text).toContain('s.id = $');
    await network.siteHealthMetrics({ now });
    expect(h.fake.find('client', 'WITH bounds AS')[1]!.text).not.toContain('s.id = $');
  });

  it('counts a site with stations but nothing going on as no activity', () => {
    const quiet = {
      siteId: 's',
      siteName: 'S',
      stations: 2,
      online: 2,
      offline: 0,
      faulted: 0,
      last24h: { sessions: 0, failedSessions: 0, refusedAuthorizations: 0, criticalAlerts: 0 },
      priorDailyAverage: {
        sessions: 0,
        failedSessions: 0,
        refusedAuthorizations: 0,
        criticalAlerts: 0,
      },
    };
    expect(network.hasActivity(quiet)).toBe(false);
    expect(
      network.hasActivity({ ...quiet, last24h: { ...quiet.last24h, criticalAlerts: 1 } }),
    ).toBe(true);
    expect(network.hasActivity({ ...quiet, stations: 0, offline: 1 })).toBe(false);
  });

  it('keeps only stations faulted for longer than the reset threshold', async () => {
    h.fake.queue('client:FROM charging_stations cs', [
      {
        id: 'sta_1',
        station_id: 'CS-1',
        ocpp_protocol: 'ocpp1.6',
        site_id: 'sit_1',
        faulted_since: '2026-11-01T05:00:00Z',
      },
      {
        id: 'sta_2',
        station_id: 'CS-2',
        ocpp_protocol: null,
        site_id: 'sit_1',
        faulted_since: new Date('2026-11-01T07:00:00Z'),
      },
    ]);
    const out = await network.longFaultedStations({ siteId: 'sit_1', now });
    expect(out.map((s) => s.stationId)).toEqual(['sta_1']);
    expect(out[0]).toMatchObject({ ocppStationId: 'CS-1', ocppProtocol: 'ocpp1.6' });
    expect(h.fake.find('client', 'FROM charging_stations cs')[0]!.params).toEqual(
      expect.arrayContaining(['sit_1', now, network.FAULTED_RESET_HOURS]),
    );
  });
});

describe('proposal digest', () => {
  it('counts pending actions per job and lists at most ten site names', async () => {
    const pending = Array.from({ length: 12 }, (_, i) => ({
      job: i === 0 ? 'network_summary' : 'stuck_sessions',
      site_id: `sit_${String(i)}`,
      site_name: `Site ${String(i).padStart(2, '0')}`,
    }));
    pending.push({ job: 'stuck_sessions', site_id: 'sit_1', site_name: 'Site 01' });
    pending.push({
      job: null as unknown as string,
      site_id: null as unknown as string,
      site_name: null as unknown as string,
    });
    h.fake.queue('client:FROM ai_proposals p', pending);
    const counts = await digest.pendingDigestCounts('usr_1', false);
    expect(counts).toMatchObject({
      pendingCount: 14,
      stuckSessionsCount: 12,
      networkSummaryCount: 1,
      siteCount: 12,
    });
    expect(counts.siteNames.endsWith(' +2')).toBe(true);
    expect(counts.siteNames.startsWith('Site 00, Site 01')).toBe(true);
    expect(h.fake.find('client', 'FROM ai_proposals p')[0]!.params).toEqual([false, 'usr_1']);
  });

  it('lists every name when there are ten or fewer', async () => {
    h.fake.queue('client:FROM ai_proposals p', [
      { job: 'stuck_sessions', site_id: 'a', site_name: 'A' },
    ]);
    expect((await digest.pendingDigestCounts('usr_1', true)).siteNames).toBe('A');
  });

  it('sends nothing on a day already claimed', async () => {
    const out = await digest.sendAiProposalDigests({
      digestDate: '2026-11-01',
      insightsUrl: 'https://csms/ai/insights',
      templatesDirs: [],
    });
    expect(out).toEqual({ sent: 0, skipped: 0, alreadySent: true });
    expect(h.fake.find('client')).toHaveLength(0);
  });

  it('sends to recipients with pending actions, skips the rest and keeps going on a failure', async () => {
    h.fake.queue('insert', [{ id: 77 }]);
    const user = (id: string, allSites = false) => ({
      id,
      email: `${id}@example.com`,
      first_name: id === 'u1' ? 'Ann' : null,
      last_name: null,
      language: 'de',
      has_all_site_access: allSites,
    });
    h.fake.queue('client:FROM users u', [user('u1', true), user('u2'), user('u3'), user('u4')]);
    const one = [{ job: 'stuck_sessions', site_id: 'a', site_name: 'A' }];
    h.fake.queue('client:FROM ai_proposals p', one);
    h.fake.queue('client:FROM ai_proposals p', []);
    h.fake.queue('client:FROM ai_proposals p', one);
    h.fake.queue('client:FROM ai_proposals p', one);
    h.deliver.push(['email'], new Error('smtp down'), []);
    const out = await digest.sendAiProposalDigests({
      digestDate: '2026-11-01',
      insightsUrl: 'https://csms/ai/insights?status=pending',
      templatesDirs: ['/t'],
      log: silentLog,
    });
    expect(out).toEqual({ sent: 1, skipped: 1, alreadySent: false });
    expect(h.dispatched).toHaveLength(3);
    expect(h.dispatched[0]).toMatchObject({
      event: digest.AI_PROPOSAL_DIGEST_EVENT,
      recipient: {
        email: 'u1@example.com',
        firstName: 'Ann',
        language: 'de',
        timezone: 'Europe/Berlin',
        userId: 'u1',
      },
      vars: {
        firstName: 'Ann',
        lastName: '',
        digestDate: '2026-11-01',
        pendingCount: 1,
        siteNames: 'A',
      },
    });
    expect(h.dispatched[1]!.recipient['firstName']).toBeUndefined();
    expect(silentLog.warn).toHaveBeenCalledTimes(1);
    const finish = h.fake.find('update')[0]!;
    expect(finish.set).toMatchObject({ status: 'completed', output: { sent: 1, skipped: 1 } });
    // The first recipient is all-site: its count binds true.
    expect(h.fake.find('client', 'FROM ai_proposals p')[0]!.params).toEqual([true, 'u1']);
  });
});
