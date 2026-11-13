// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The AI insights scope writer: reads, validation, the flag writes in both
// modes, the audit rows and the closing of what left the scope.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

const state = vi.hoisted(() => ({
  clientQueue: [] as unknown[][],
  clientCalls: [] as string[],
  storedMode: undefined as string | undefined,
  sites: [] as { id: string; on: boolean }[],
  stations: [] as { id: string; on: boolean }[],
  inScope: [] as { sites: string[]; stations: [string, string | null][] }[],
  inScopeCall: 0,
  inserts: [] as unknown[],
  updates: [] as { table: string; set: Record<string, unknown>; where: unknown }[],
  allReturning: { sites: [] as { id: string }[], chargingStations: [] as { id: string }[] },
  featureOn: true,
}));

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  expireSiteAiProposals: vi.fn(() => Promise.resolve(2)),
  expireStationAiProposals: vi.fn(() => Promise.resolve(1)),
  dismissSiteInsights: vi.fn(() => Promise.resolve([{ id: 'a' }, { id: 'b' }, { id: 'c' }])),
  dismissStationInsights: vi.fn(() => Promise.resolve([{ id: 'd' }])),
}));

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'),
    values,
  });
  sql.raw = (s: string) => ({ raw: s });
  return {
    sql,
    and: (...c: unknown[]) => ({ and: c }),
    eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
    inArray: (col: unknown, v: unknown) => ({ inArray: [col, v] }),
  };
});

vi.mock('@evtivity/database', () => {
  const client = Object.assign(
    (strings: TemplateStringsArray) => {
      state.clientCalls.push(strings.join('?'));
      return Promise.resolve(state.clientQueue.shift() ?? []);
    },
    { unsafe: (s: string) => s },
  );
  const sites = { __name: 'sites', id: 'sites.id', aiInsightsEnabled: 'sites.ai' };
  const chargingStations = {
    __name: 'chargingStations',
    id: 'cs.id',
    aiInsightsEnabled: 'cs.ai',
  };
  const settings = { __name: 'settings', key: 'settings.key', value: 'settings.value' };
  type Table = { __name: string };
  const tx = {
    execute: (q: { text: string }) => {
      if (q.text.includes('pg_advisory')) return Promise.resolve([]);
      const snap = state.inScope[Math.floor(state.inScopeCall / 2)] ?? { sites: [], stations: [] };
      state.inScopeCall += 1;
      if (q.text.includes('FROM sites s')) return Promise.resolve(snap.sites.map((id) => ({ id })));
      return Promise.resolve(snap.stations.map(([id, site_id]) => ({ id, site_id })));
    },
    select: () => ({
      from: (t: Table) => ({
        where: () => {
          if (t.__name === 'sites') return Promise.resolve(state.sites);
          if (t.__name === 'chargingStations') return Promise.resolve(state.stations);
          return Promise.resolve(
            state.storedMode === undefined ? [] : [{ value: state.storedMode }],
          );
        },
      }),
    }),
    insert: () => ({
      values: (v: unknown) => ({
        onConflictDoUpdate: () => {
          state.inserts.push(v);
          return Promise.resolve();
        },
      }),
    }),
    update: (t: Table) => ({
      set: (s: Record<string, unknown>) => ({
        where: (w: unknown) => {
          state.updates.push({ table: t.__name, set: s, where: w });
          return Object.assign(Promise.resolve(), {
            returning: () =>
              Promise.resolve(state.allReturning[t.__name as 'sites' | 'chargingStations']),
          });
        },
      }),
    }),
  };
  return {
    client,
    db: { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    chargingStations,
    sites,
    settings,
    settingAuditLog: { name: 'settingAuditLog' },
    siteAuditLog: { name: 'siteAuditLog' },
    stationAuditLog: { name: 'stationAuditLog' },
    isAiInsightsEnabled: () => Promise.resolve(state.featureOn),
    operatorStationSql: (a: string) => `op(${a})`,
    siteInsightScopeReasonSql: (a: string) => `sreason(${a})`,
    siteInsightsInScopeSql: (a: string) => `sin(${a})`,
    stationInsightScopeReasonSql: (a: string) => `streason(${a})`,
    stationInsightsInScopeSql: (a: string) => `stin(${a})`,
    writeAudit: mocks.writeAudit,
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ pubsub: true }) }));
vi.mock('@evtivity/services/ai-insight.service', () => ({
  dismissSiteInsights: mocks.dismissSiteInsights,
  dismissStationInsights: mocks.dismissStationInsights,
}));
vi.mock('@evtivity/services/ai-proposal.service', () => ({
  expireSiteAiProposals: mocks.expireSiteAiProposals,
  expireStationAiProposals: mocks.expireStationAiProposals,
}));

import {
  AiInsightScopeError,
  aiInsightsScopeStatusOf,
  initialSiteAiInsightsSelected,
  isOutsideAiInsightScope,
  readAiInsightScope,
  readAiInsightScopeMode,
  readAiInsightScopeStations,
  siteAiInsightsScopeStatus,
  stationAiInsightsScopeStatus,
  updateAiInsightScope,
} from '../services/ai-insight-scope.service.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

const log = pino({ level: 'silent' });
const actor: AuditActorInfo = {
  actor: 'operator',
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: 'Admin',
};

// readAiInsightScope after the update: mode, sites, lone stations.
function queueReadScope(mode: string): void {
  state.clientQueue.push([{ value: mode }], [], [{ n: 0 }]);
}

beforeEach(() => {
  state.clientQueue = [];
  state.clientCalls = [];
  state.storedMode = undefined;
  state.sites = [];
  state.stations = [];
  state.inScope = [];
  state.inScopeCall = 0;
  state.inserts = [];
  state.updates = [];
  state.allReturning = { sites: [], chargingStations: [] };
  state.featureOn = true;
});

describe('scope reads', () => {
  it('reads the stored mode and falls back to all for a missing or unknown value', async () => {
    state.clientQueue.push([{ value: 'selected' }]);
    expect(await readAiInsightScopeMode()).toBe('selected');
    state.clientQueue.push([{ value: 'bogus' }]);
    expect(await readAiInsightScopeMode()).toBe('all');
    state.clientQueue.push([]);
    expect(await readAiInsightScopeMode()).toBe('all');
  });

  it('starts a new site selected unless the scope is selected', async () => {
    state.clientQueue.push([{ value: 'selected' }]);
    expect(await initialSiteAiInsightsSelected()).toBe(false);
    state.clientQueue.push([{ value: 'all' }]);
    expect(await initialSiteAiInsightsSelected()).toBe(true);
  });

  it('maps the sites with their station counts and counts lone stations', async () => {
    state.clientQueue.push(
      [{ value: 'selected' }],
      [{ id: 'sit_a', name: 'A', selected: true, station_count: 3, turned_off: 1 }],
      [{ n: 4 }],
    );
    expect(await readAiInsightScope()).toEqual({
      mode: 'selected',
      sites: [{ id: 'sit_a', name: 'A', selected: true, stationCount: 3, stationsTurnedOff: 1 }],
      stationsWithoutSite: 4,
    });
    state.clientQueue.push([{ value: 'all' }], [], []);
    expect((await readAiInsightScope()).stationsWithoutSite).toBe(0);
  });

  it('lists the stations of a site, null for an unknown site', async () => {
    state.clientQueue.push([]);
    expect(await readAiInsightScopeStations('sit_x')).toBeNull();
    state.clientQueue.push([{ id: 'sit_a' }], [{ id: 'sta_1', station_id: 'CP1', enabled: false }]);
    expect(await readAiInsightScopeStations('sit_a')).toEqual([
      { id: 'sta_1', stationId: 'CP1', enabled: false },
    ]);
  });

  it('gives the station and site status, null when unknown', async () => {
    state.clientQueue.push([]);
    expect(await stationAiInsightsScopeStatus('sta_x')).toBeNull();
    state.clientQueue.push([{ reason: 'station_turned_off' }]);
    expect(await stationAiInsightsScopeStatus('sta_1')).toEqual({
      enabled: false,
      reason: 'station_turned_off',
    });
    state.clientQueue.push([]);
    expect(await siteAiInsightsScopeStatus('sit_x')).toBeNull();
    state.clientQueue.push([{ reason: 'selected' }]);
    expect(await siteAiInsightsScopeStatus('sit_a')).toEqual({
      enabled: true,
      reason: 'selected',
    });
  });

  it('reads feature_off for an in-scope reason while AI insights are off', async () => {
    state.featureOn = false;
    expect(await aiInsightsScopeStatusOf('all_sites')).toEqual({
      enabled: false,
      reason: 'feature_off',
    });
    expect(await aiInsightsScopeStatusOf('no_site')).toEqual({
      enabled: false,
      reason: 'no_site',
    });
  });

  it('counts only a selection as outside the scope, not AI insights off', () => {
    expect(isOutsideAiInsightScope({ enabled: false, reason: 'feature_off' })).toBe(false);
    expect(isOutsideAiInsightScope({ enabled: false, reason: 'site_not_selected' })).toBe(true);
    expect(isOutsideAiInsightScope({ enabled: true, reason: 'selected' })).toBe(false);
  });
});

describe('updateAiInsightScope validation', () => {
  it('refuses site or station lists with the all mode', async () => {
    await expect(
      updateAiInsightScope(
        { mode: 'all', sites: [{ siteId: 'sit_a', selected: true }] },
        actor,
        log,
      ),
    ).rejects.toThrow('Sites and stations are chosen only for the selected scope');
    await expect(
      updateAiInsightScope(
        { mode: 'all', stations: [{ stationId: 'sta_1', enabled: true }] },
        actor,
        log,
      ),
    ).rejects.toBeInstanceOf(AiInsightScopeError);
  });

  it('refuses an id listed twice, naming it', async () => {
    const err = await updateAiInsightScope(
      {
        mode: 'selected',
        sites: [
          { siteId: 'sit_a', selected: true },
          { siteId: 'sit_a', selected: false },
        ],
      },
      actor,
      log,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiInsightScopeError);
    expect((err as AiInsightScopeError).message).toBe('A site listed more than once');
    expect((err as AiInsightScopeError).ids).toEqual(['sit_a']);

    const err2 = await updateAiInsightScope(
      {
        mode: 'selected',
        stations: [
          { stationId: 'sta_1', enabled: true },
          { stationId: 'sta_1', enabled: true },
        ],
      },
      actor,
      log,
    ).catch((e: unknown) => e);
    expect((err2 as AiInsightScopeError).message).toBe('A station listed more than once');
  });

  it('refuses unknown sites and stations and writes nothing', async () => {
    state.sites = [{ id: 'sit_a', on: true }];
    const err = await updateAiInsightScope(
      {
        mode: 'selected',
        sites: [
          { siteId: 'sit_a', selected: true },
          { siteId: 'sit_x', selected: true },
        ],
      },
      actor,
      log,
    ).catch((e: unknown) => e);
    expect((err as AiInsightScopeError).message).toBe('Unknown site');
    expect((err as AiInsightScopeError).ids).toEqual(['sit_x']);

    state.stations = [];
    const err2 = await updateAiInsightScope(
      { mode: 'selected', stations: [{ stationId: 'sta_x', enabled: false }] },
      actor,
      log,
    ).catch((e: unknown) => e);
    expect((err2 as AiInsightScopeError).message).toBe('Unknown station');
    expect((err2 as AiInsightScopeError).ids).toEqual(['sta_x']);
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('updateAiInsightScope writes', () => {
  it('switching to all selects every site, turns every station on and audits each', async () => {
    state.storedMode = 'selected';
    state.allReturning = { sites: [{ id: 'sit_b' }], chargingStations: [{ id: 'sta_2' }] };
    state.inScope = [
      { sites: ['sit_a'], stations: [['sta_1', 'sit_a']] },
      {
        sites: ['sit_a', 'sit_b'],
        stations: [
          ['sta_1', 'sit_a'],
          ['sta_2', 'sit_b'],
        ],
      },
    ];
    queueReadScope('all');

    const result = await updateAiInsightScope({ mode: 'all' }, actor, log);

    expect(state.inserts).toEqual([{ key: 'aiInsights.scope', value: 'all' }]);
    expect(state.updates.map((u) => [u.table, u.set['aiInsightsEnabled']])).toEqual([
      ['sites', true],
      ['chargingStations', true],
    ]);
    expect(result).toMatchObject({
      sitesRemoved: 0,
      stationsRemoved: 0,
      insightsDismissed: 0,
      actionsExpired: 0,
    });
    expect(result.scope.mode).toBe('all');
    const audits = mocks.writeAudit.mock.calls.map(
      (c) => c as unknown as [{ table: { name: string } }, { notes: string; entityId: string }],
    );
    expect(audits.map(([t, a]) => [t.table.name, a.entityId, a.notes])).toEqual([
      ['settingAuditLog', 'aiInsights.scope', 'AI insights scope changed'],
      ['siteAuditLog', 'sit_b', 'Added to the AI insights scope'],
      ['stationAuditLog', 'sta_2', 'Turned on in the AI insights scope'],
    ]);
    expect(mocks.dismissSiteInsights).not.toHaveBeenCalled();
  });

  it('keeps the mode, flips only changed flags and closes what left the scope', async () => {
    state.storedMode = 'selected';
    state.sites = [
      { id: 'sit_a', on: true },
      { id: 'sit_b', on: false },
    ];
    state.stations = [
      { id: 'sta_3', on: true },
      { id: 'sta_4', on: true },
    ];
    state.inScope = [
      {
        sites: ['sit_a', 'sit_c'],
        stations: [
          ['sta_1', 'sit_a'],
          ['sta_3', 'sit_c'],
          ['sta_5', null],
        ],
      },
      { sites: ['sit_c'], stations: [] },
    ];
    queueReadScope('selected');

    const result = await updateAiInsightScope(
      {
        mode: 'selected',
        sites: [
          { siteId: 'sit_a', selected: false },
          { siteId: 'sit_b', selected: false },
        ],
        stations: [
          { stationId: 'sta_3', enabled: false },
          { stationId: 'sta_4', enabled: true },
        ],
      },
      actor,
      log,
    );

    // No mode write (unchanged), only sit_a and sta_3 flip off.
    expect(state.inserts).toEqual([]);
    expect(state.updates).toHaveLength(2);
    expect(state.updates.map((u) => [u.table, u.set['aiInsightsEnabled'], u.where])).toEqual([
      ['sites', false, { inArray: ['sites.id', ['sit_a']] }],
      ['chargingStations', false, { inArray: ['cs.id', ['sta_3']] }],
    ]);

    // sit_a left: its station sta_1 is covered by the site close; sta_3 and
    // the lone sta_5 close on their own.
    expect(mocks.expireSiteAiProposals).toHaveBeenCalledTimes(1);
    expect(mocks.expireSiteAiProposals).toHaveBeenCalledWith(
      'sit_a',
      'Removed from the AI insights scope',
      { actor: 'operator', actorUserId: 'usr_1', actorLabel: 'Admin' },
      log,
    );
    expect(mocks.dismissSiteInsights).toHaveBeenCalledWith(
      'sit_a',
      'Removed from the AI insights scope',
      { actor: 'operator', actorUserId: 'usr_1', actorApiKeyId: null },
      { pubsub: true },
      'ai_insights_scope',
    );
    expect(mocks.expireStationAiProposals.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'sta_3',
      'sta_5',
    ]);
    expect(result).toMatchObject({
      sitesRemoved: 1,
      stationsRemoved: 3,
      actionsExpired: 2 + 1 + 1,
      insightsDismissed: 3 + 1 + 1,
    });
    const notes = mocks.writeAudit.mock.calls.map(
      (c) => (c as unknown as [unknown, { notes: string; entityId: string }])[1],
    );
    expect(notes.map((a) => [a.entityId, a.notes])).toEqual([
      ['sit_a', 'Removed from the AI insights scope'],
      ['sta_3', 'Turned off in the AI insights scope'],
    ]);
  });

  it('writes the mode when it changes to selected and turns things on', async () => {
    state.storedMode = 'bogus';
    state.sites = [{ id: 'sit_a', on: false }];
    state.stations = [{ id: 'sta_1', on: false }];
    state.inScope = [
      { sites: [], stations: [] },
      { sites: ['sit_a'], stations: [['sta_1', 'sit_a']] },
    ];
    queueReadScope('selected');
    await updateAiInsightScope(
      {
        mode: 'selected',
        sites: [{ siteId: 'sit_a', selected: true }],
        stations: [{ stationId: 'sta_1', enabled: true }],
      },
      actor,
      log,
    );
    expect(state.inserts).toEqual([{ key: 'aiInsights.scope', value: 'selected' }]);
    expect(state.updates.map((u) => [u.table, u.set['aiInsightsEnabled']])).toEqual([
      ['sites', true],
      ['chargingStations', true],
    ]);
    const first = mocks.writeAudit.mock.calls[0] as unknown as [
      unknown,
      { before: unknown; after: unknown },
    ];
    // An unknown stored value counts as the default mode.
    expect(first[1].before).toEqual({ key: 'aiInsights.scope', value: 'all' });
    expect(first[1].after).toEqual({ key: 'aiInsights.scope', value: 'selected' });
  });

  it('logs a failed close and still closes the others', async () => {
    state.storedMode = 'selected';
    state.sites = [
      { id: 'sit_a', on: true },
      { id: 'sit_b', on: true },
    ];
    state.inScope = [
      { sites: ['sit_a', 'sit_b'], stations: [['sta_9', null]] },
      { sites: [], stations: [] },
    ];
    queueReadScope('selected');
    mocks.expireSiteAiProposals.mockRejectedValueOnce(new Error('db down'));
    mocks.expireStationAiProposals.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(log, 'warn');
    const result = await updateAiInsightScope(
      {
        mode: 'selected',
        sites: [
          { siteId: 'sit_a', selected: false },
          { siteId: 'sit_b', selected: false },
        ],
      },
      actor,
      log,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_a' }),
      'Closing the AI insights of a site that left the scope failed',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'sta_9' }),
      'Closing the AI insights of a station that left the scope failed',
    );
    expect(mocks.dismissSiteInsights).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sitesRemoved: 2, actionsExpired: 2, insightsDismissed: 3 });
  });
});
