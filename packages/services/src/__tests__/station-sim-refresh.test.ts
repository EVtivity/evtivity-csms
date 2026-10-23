// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const inserted = new Map<string, unknown[]>();
  const conflictTargets: string[] = [];
  const selectChain = {
    from: () => selectChain,
    where: () => Object.assign(Promise.resolve([]), { for: () => Promise.resolve([]) }),
  };
  const insert = vi.fn((table: { name: string }) => ({
    values: (rows: unknown) => {
      const list: unknown[] = Array.isArray(rows) ? rows : [rows];
      inserted.set(table.name, [...(inserted.get(table.name) ?? []), ...list]);
      const done = Promise.resolve(list.map((_, id) => ({ id })));
      return {
        onConflictDoNothing: () => {
          conflictTargets.push(table.name);
          return { returning: () => done };
        },
        then: done.then.bind(done),
      };
    },
  }));
  const tx = { execute: vi.fn(), select: () => selectChain, delete: vi.fn(), insert };
  return {
    tx,
    inserted,
    conflictTargets,
    db: {
      select: vi.fn(() => selectChain),
      insert,
      transaction: vi.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
    getSim: vi.fn(),
    lookup: vi.fn(),
    sessionsSynced: vi.fn(),
    alertsSynced: vi.fn(),
    status: vi.fn(),
    writeAudit: vi.fn(),
    attachReported: vi.fn(),
  };
});
const { db, inserted, conflictTargets } = h;

vi.mock('@evtivity/database', () => ({
  db: h.db,
  chargingStations: { name: 'charging_stations', iccid: 'iccid', id: 'id' },
  sims: { name: 'sims', id: 'id' },
  simAttachments: { name: 'sim_attachments', simId: 'sim_id', detachedAt: 'detached_at' },
  simAuditLog: { name: 'sim_audit_log' },
  simSessions: { name: 'sim_sessions', provider: 'provider', providerSessionId: 'psid', id: 'id' },
  simAlerts: { name: 'sim_alerts', provider: 'provider', providerAlertId: 'paid', id: 'id' },
  simFetchCoverage: {
    name: 'sim_fetch_coverage',
    simId: 'sim_id',
    provider: 'provider',
    coveredFrom: 'covered_from',
    coveredTo: 'covered_to',
    id: 'id',
  },
  getSimProviderSettings: vi.fn(),
  getSim: h.getSim,
  recordSimLookup: h.lookup,
  recordSimStatus: h.status,
  recordSimSessionsSynced: h.sessionsSynced,
  recordSimAlertsSynced: h.alertsSynced,
  writeAudit: h.writeAudit,
  compareRecordIds: (a: string, b: string) => Number(a) - Number(b),
}));
vi.mock('../sim-inventory.service.js', () => ({ attachReportedStationSim: h.attachReported }));

import { SimProviderError, type SimProvider, type SimSession } from '@evtivity/sim-providers';
import {
  refreshSimProvider,
  refreshStationSimProvider,
  resetSimNetwork,
  SIM_KEYS,
  type SimKeyStore,
  type SimRefreshContext,
  type SimRefreshPeriod,
} from '../station-sim.service.js';

const mockSessionsSynced = h.sessionsSynced;
const mockAlertsSynced = h.alertsSynced;
const mockStatus = h.status;

function simRow(fields: Record<string, unknown> = {}) {
  return {
    id: 'sim_1',
    iccid: '8944500102198304826',
    provider: 'hologram',
    providerRef: '4001',
    providerMeta: { linkId: '5001' },
    lookupMissedAt: null,
    lastRecordId: null,
    sessionsSyncedAt: null,
    status: 'active',
    ...fields,
  };
}

function attachedTo(confirmed: boolean, fields: Record<string, unknown> = {}) {
  return {
    kind: 'attached',
    sim: simRow(fields),
    attachment: {
      id: 7,
      simId: 'sim_1',
      stationId: 'sta_1',
      confirmedAt: confirmed ? new Date() : null,
    },
  };
}

const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const PERIOD: SimRefreshPeriod = {
  mode: 'days',
  from: new Date(NOW.getTime() - 7 * DAY),
  to: NOW,
};
const LOCK = SIM_KEYS.lock('sim_1');

let events: string[] = [];

/** Redis semantics in memory: SET NX, compare-and-set renew, compare-and-delete release. */
class MemoryKeyStore implements SimKeyStore {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  renewResults: boolean[] = [];
  onRenew: (() => void) | null = null;

  acquire(key: string, token: string): Promise<boolean> {
    events.push('acquire');
    if (this.data.has(key)) return Promise.resolve(false);
    this.data.set(key, token);
    return Promise.resolve(true);
  }
  renew(key: string, token: string): Promise<boolean> {
    events.push('renew');
    this.onRenew?.();
    const forced = this.renewResults.shift();
    if (forced != null) return Promise.resolve(forced);
    return Promise.resolve(this.data.get(key) === token);
  }
  release(key: string, token: string): Promise<void> {
    events.push('release');
    if (this.data.get(key) === token) this.data.delete(key);
    return Promise.resolve();
  }
  ttlSeconds(key: string): Promise<number | null> {
    return Promise.resolve(this.ttls.get(key) ?? null);
  }
  setFor(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds);
    return Promise.resolve();
  }
  increment(): Promise<number> {
    return Promise.resolve(1);
  }
}

function session(id: number, startedAt: Date): SimSession {
  return {
    providerSessionId: String(id),
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + 60_000).toISOString(),
    bytes: 100,
    networkName: null,
    radioAccessTechnology: null,
    cellId: null,
    apn: null,
  };
}

function fakeProvider(sessionPages: SimSession[][]): SimProvider {
  let page = 0;
  return {
    id: 'hologram',
    historyDays: 90,
    reportingDelayHours: 6,
    capabilities: {},
    findByIccid: vi.fn(() => {
      events.push('findByIccid');
      return Promise.resolve(null);
    }),
    getStatus: vi.fn(() => {
      events.push('getStatus');
      return Promise.resolve({
        providerSimId: '4001',
        state: 'active',
        providerState: 'LIVE',
        inSession: false,
        openSessionBeganAt: null,
        apn: null,
        profileName: null,
        lastSessionAt: null,
        usage: null,
      });
    }),
    listSessions: vi.fn(() => {
      events.push('listSessions');
      const items = sessionPages[page] ?? [];
      page += 1;
      const continues = page < sessionPages.length;
      return Promise.resolve({
        items,
        continues,
        lastId: items[items.length - 1]?.providerSessionId ?? null,
      });
    }),
    listAlerts: vi.fn(() => {
      events.push('listAlerts');
      return Promise.resolve({ items: [], continues: false, lastId: null });
    }),
  } as unknown as SimProvider;
}

function context(keys: SimKeyStore, provider: SimProvider) {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx: SimRefreshContext = {
    registry: {
      enabledProviders: vi.fn().mockResolvedValue([provider]),
      getProvider: vi.fn().mockResolvedValue(provider),
    } as unknown as SimRefreshContext['registry'],
    keys,
    actor: { actor: 'operator', actorUserId: 'usr_1' },
    log: log,
    // The fetch runs a moment after the period was set, as in a real request.
    now: () => new Date(NOW.getTime() + 50),
  };
  return { ctx, log };
}

const TWO_PAGES = [
  [session(30, new Date(NOW.getTime() - DAY)), session(29, new Date(NOW.getTime() - 2 * DAY))],
  [session(28, new Date(NOW.getTime() - 3 * DAY))],
];

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  inserted.clear();
  conflictTargets.length = 0;
  h.attachReported.mockResolvedValue(attachedTo(true));
  h.getSim.mockResolvedValue(simRow());
  h.lookup.mockResolvedValue('recorded');
});

describe('refreshStationSimProvider: the station attachment', () => {
  it('writes and asks nothing while no provider is on', async () => {
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    vi.mocked(ctx.registry.enabledProviders).mockResolvedValue([]);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'provider_off',
    });
    expect(h.attachReported).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it.each(['no_iccid', 'attached_elsewhere', 'attach_conflict', 'sim_inactive'] as const)(
    'skips with %s and calls no provider',
    async (kind) => {
      h.attachReported.mockResolvedValue({ kind });
      const keys = new MemoryKeyStore();
      const provider = fakeProvider(TWO_PAGES);
      const { ctx } = context(keys, provider);
      expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
        result: 'skipped',
        reason: kind,
      });
      expect(events).toEqual([]);
    },
  );

  it('looks an unconfirmed attachment up but fetches nothing (not_confirmed)', async () => {
    h.attachReported.mockResolvedValue(
      attachedTo(false, { provider: null, providerRef: null, providerMeta: null }),
    );
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    vi.mocked(provider.findByIccid).mockResolvedValue({ providerSimId: '4001' });
    const { ctx } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'not_confirmed',
      provider: 'hologram',
    });
    expect(provider.findByIccid).toHaveBeenCalledTimes(1);
    expect(h.lookup).toHaveBeenCalledWith(
      'sim_1',
      expect.objectContaining({ providerRef: '4001' }),
    );
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.listSessions).not.toHaveBeenCalled();
    expect(provider.listAlerts).not.toHaveBeenCalled();
    expect(mockStatus).not.toHaveBeenCalled();
    expect(inserted.size).toBe(0);
    expect(keys.data.has(LOCK)).toBe(false);
  });

  it('passes the person who pressed Refresh to the attach, for its audit rows', async () => {
    const { ctx } = context(new MemoryKeyStore(), fakeProvider(TWO_PAGES));
    await refreshStationSimProvider(ctx, 'sta_1', PERIOD);
    expect(h.attachReported).toHaveBeenCalledWith('sta_1', ctx.actor, ctx.log);
  });
});

describe('refreshSimProvider: the SIM page', () => {
  it('fetches a SIM whatever its attachment, with no attach step', async () => {
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    expect(await refreshSimProvider(ctx, 'sim_1', PERIOD)).toMatchObject({
      result: 'ok',
      sessionsStored: 3,
    });
    expect(h.attachReported).not.toHaveBeenCalled();
    expect(provider.getStatus).toHaveBeenCalledTimes(1);
  });

  it('calls no provider for an inactive SIM and takes no lock', async () => {
    h.getSim.mockResolvedValue(simRow({ status: 'inactive' }));
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    expect(await refreshSimProvider(ctx, 'sim_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'sim_inactive',
    });
    expect(events).toEqual([]);
  });

  it('stores rows keyed by the SIM, inserted ON CONFLICT DO NOTHING', async () => {
    const { ctx } = context(new MemoryKeyStore(), fakeProvider(TWO_PAGES));
    await refreshSimProvider(ctx, 'sim_1', PERIOD);
    const sessions = (inserted.get('sim_sessions') ?? []) as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s['simId'] === 'sim_1' && !('stationId' in s))).toBe(true);
    expect(conflictTargets.filter((t) => t === 'sim_sessions')).toHaveLength(2);
    const [coverage] = (inserted.get('sim_fetch_coverage') ?? []) as Array<Record<string, unknown>>;
    expect(coverage).toMatchObject({ simId: 'sim_1', provider: 'hologram' });
    // Coverage of one SIM is merged under an advisory lock keyed by the SIM.
    const locks = h.tx.execute.mock.calls.map((call) => {
      const query = new PgDialect().sqlToQuery(call[0] as SQL);
      return { sql: query.sql, params: query.params };
    });
    expect(locks).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['sim_coverage:sim_1'] },
    ]);
  });

  it('answers sim_inactive for an inactive SIM even while no provider is on', async () => {
    h.getSim.mockResolvedValue(simRow({ status: 'inactive' }));
    const { ctx } = context(new MemoryKeyStore(), fakeProvider(TWO_PAGES));
    vi.mocked(ctx.registry.enabledProviders).mockResolvedValue([]);
    expect(await refreshSimProvider(ctx, 'sim_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'sim_inactive',
    });
  });

  it('calls no provider for a SIM deactivated while the fetch lock was taken', async () => {
    // Active when the route read it, inactive once the lock is held.
    h.getSim.mockResolvedValueOnce(simRow()).mockResolvedValue(simRow({ status: 'inactive' }));
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    expect(await refreshSimProvider(ctx, 'sim_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'sim_inactive',
    });
    expect(events).toEqual(['acquire', 'release']);
    expect(provider.findByIccid).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(keys.data.has(LOCK)).toBe(false);
  });

  it('answers not_found for a SIM deleted since the route read it', async () => {
    h.getSim.mockResolvedValue(null);
    const { ctx } = context(new MemoryKeyStore(), fakeProvider(TWO_PAGES));
    expect(await refreshSimProvider(ctx, 'sim_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'not_found',
    });
    expect(events).toEqual([]);
  });
});

describe('refreshStationSimProvider coverage', () => {
  it('records a range only up to the reporting delay, and nothing when the range is all newer', async () => {
    const keys = new MemoryKeyStore();
    const { ctx } = context(keys, fakeProvider([[]]));
    const fetched = NOW.getTime() + 50;
    await refreshStationSimProvider(ctx, 'sta_1', {
      mode: 'range',
      from: new Date(NOW.getTime() - 2 * DAY),
      to: NOW,
    });
    const [row] = (inserted.get('sim_fetch_coverage') ?? []) as Array<{
      coveredFrom: Date;
      coveredTo: Date;
    }>;
    expect(row?.coveredFrom).toEqual(new Date(NOW.getTime() - 2 * DAY));
    expect(row?.coveredTo).toEqual(new Date(fetched - 6 * 3_600_000));

    inserted.clear();
    await refreshStationSimProvider(ctx, 'sta_1', {
      mode: 'range',
      from: new Date(NOW.getTime() - 3_600_000),
      to: NOW,
    });
    expect(inserted.get('sim_fetch_coverage')).toBeUndefined();
  });
});

describe('refreshStationSimProvider lookup rate limit', () => {
  it('backs off the provider that answered 429, not the first enabled one', async () => {
    h.attachReported.mockResolvedValue(
      attachedTo(true, { provider: null, providerRef: null, providerMeta: null }),
    );
    const first = { ...fakeProvider([]), id: 'first' } as unknown as SimProvider;
    const second = fakeProvider([]);
    vi.mocked(second.findByIccid).mockRejectedValue(
      new SimProviderError('rate_limited', 'slow down', { retryAfterSeconds: 45 }),
    );
    const keys = new MemoryKeyStore();
    const { ctx } = context(keys, second);
    vi.mocked(ctx.registry.enabledProviders).mockResolvedValue([first, second]);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'rate_limited',
      retryAfter: 45,
    });
    expect(keys.ttls.get(SIM_KEYS.backoff('hologram'))).toBe(45);
    expect(keys.ttls.has(SIM_KEYS.backoff('first'))).toBe(false);
  });
});

describe('resetSimNetwork', () => {
  function resetContext(keys: SimKeyStore, provider: SimProvider) {
    const { ctx, log } = context(keys, provider);
    return { ctx: { registry: ctx.registry, keys, actor: ctx.actor, log: ctx.log }, log };
  }
  function resettable(): SimProvider {
    const provider = fakeProvider([]);
    Object.assign(provider, {
      capabilities: { networkReset: true },
      resetNetwork: vi.fn().mockResolvedValue({ status: 'accepted' }),
    });
    return provider;
  }

  it('refuses an inactive SIM before any provider call or cooldown', async () => {
    h.getSim.mockResolvedValue(simRow({ status: 'inactive' }));
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'sim_inactive' });
    expect(provider.resetNetwork).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('resets once a minute per SIM, audits the SIM and reports the attached station', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    const onOutcome = vi.fn().mockResolvedValue(undefined);
    const attached = {
      from: () => attached,
      where: () => Promise.resolve([{ stationId: 'sta_1' }]),
    };
    db.select.mockImplementationOnce(() => attached as unknown as ReturnType<typeof db.select>);
    expect(await resetSimNetwork(ctx, 'sim_1', { onOutcome })).toEqual({
      kind: 'reset',
      status: 'accepted',
    });
    expect(provider.resetNetwork).toHaveBeenCalledWith({
      providerSimId: '4001',
      linkId: '5001',
    });
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(true);
    expect(onOutcome).toHaveBeenCalledWith('accepted', 'sta_1');
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'sim_1',
      action: 'network_reset',
      notes: 'SimNetworkReset (accepted)',
      // The row names the attached station, so the audit view scopes it to that site.
      after: { outcome: 'accepted', stationId: 'sta_1' },
    });

    keys.ttls.set(SIM_KEYS.reset('sim_1'), 42);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'cooldown', retryAfter: 42 });
    expect(provider.resetNetwork).toHaveBeenCalledTimes(1);
  });

  it('re-checks after the cooldown that the caller may still reset this SIM (security review L3)', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    const stillAllowed = vi.fn().mockResolvedValue(false);
    expect(await resetSimNetwork(ctx, 'sim_1', { stillAllowed })).toEqual({
      kind: 'sim_not_found',
    });
    expect(stillAllowed).toHaveBeenCalledTimes(1);
    expect(provider.resetNetwork).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
    // The cooldown is given back.
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(false);

    stillAllowed.mockRejectedValueOnce(new Error('database down'));
    await expect(resetSimNetwork(ctx, 'sim_1', { stillAllowed })).rejects.toThrow('database down');
    expect(provider.resetNetwork).not.toHaveBeenCalled();
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(false);
  });

  it('hides the audit row from site-restricted viewers when the attached station is not read (security review I1)', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    const onOutcome = vi.fn().mockResolvedValue(undefined);
    const failing = {
      from: () => failing,
      where: () => Promise.reject(new Error('database down')),
    };
    db.select.mockImplementationOnce(() => failing as unknown as ReturnType<typeof db.select>);
    expect(await resetSimNetwork(ctx, 'sim_1', { onOutcome })).toEqual({
      kind: 'reset',
      status: 'accepted',
    });
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'network_reset',
      after: { outcome: 'accepted', stationId: null, stationUnknown: true },
    });
    expect(onOutcome).toHaveBeenCalledWith('accepted', null);
  });

  it('keeps one accepted row and the cooldown when onOutcome fails, with no rethrow', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx, log } = resetContext(keys, provider);
    const onOutcome = vi.fn().mockRejectedValue(new Error('station audit failed'));
    expect(await resetSimNetwork(ctx, 'sim_1', { onOutcome })).toEqual({
      kind: 'reset',
      status: 'accepted',
    });
    expect(provider.resetNetwork).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({ notes: 'SimNetworkReset (accepted)' });
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1', outcome: 'accepted' }),
      expect.any(String),
    );
  });

  it('keeps the accepted outcome when the attachment read fails: no station named', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    const failing = {
      from: () => failing,
      where: () => Promise.reject(new Error('connection lost')),
    };
    db.select.mockImplementationOnce(() => failing as unknown as ReturnType<typeof db.select>);
    const onOutcome = vi.fn();
    expect(await resetSimNetwork(ctx, 'sim_1', { onOutcome })).toEqual({
      kind: 'reset',
      status: 'accepted',
    });
    expect(onOutcome).toHaveBeenCalledWith('accepted', null);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      after: { outcome: 'accepted', stationId: null },
    });
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(true);
  });

  it('calls no provider for a SIM deactivated while the cooldown was taken', async () => {
    h.getSim.mockResolvedValueOnce(simRow()).mockResolvedValue(simRow({ status: 'inactive' }));
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'sim_inactive' });
    expect(provider.resetNetwork).not.toHaveBeenCalled();
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(false);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses without a cooldown when Redis fails, with no provider call', async () => {
    const keys = new MemoryKeyStore();
    keys.acquire = vi.fn().mockRejectedValue(new Error('connection lost'));
    const provider = resettable();
    const { ctx } = resetContext(keys, provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'unavailable' });
    expect(provider.resetNetwork).not.toHaveBeenCalled();
  });

  it.each([
    ['not_looked_up', { provider: null, providerRef: null }],
    ['sim_not_found', null],
  ])('answers %s with no provider call', async (kind, fields) => {
    h.getSim.mockResolvedValue(fields == null ? null : simRow(fields));
    const provider = resettable();
    const { ctx } = resetContext(new MemoryKeyStore(), provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind });
    expect(provider.resetNetwork).not.toHaveBeenCalled();
  });

  it('answers unsupported without the capability', async () => {
    const provider = fakeProvider([]);
    const { ctx } = resetContext(new MemoryKeyStore(), provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'unsupported' });
  });

  it('backs off after a provider 429 and reports the provider error', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    const error = new SimProviderError('rate_limited', 'slow down', { retryAfterSeconds: 30 });
    vi.mocked(provider.resetNetwork).mockRejectedValue(error);
    const { ctx } = resetContext(keys, provider);
    expect(await resetSimNetwork(ctx, 'sim_1')).toEqual({ kind: 'provider_error', error });
    expect(keys.ttls.get(SIM_KEYS.backoff('hologram'))).toBe(30);
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({ notes: 'SimNetworkReset (failed)' });
  });

  it('gives the cooldown back and rethrows an error that is not a provider error', async () => {
    const keys = new MemoryKeyStore();
    const provider = resettable();
    vi.mocked(provider.resetNetwork).mockRejectedValue(new Error('socket hang up'));
    const { ctx } = resetContext(keys, provider);
    await expect(resetSimNetwork(ctx, 'sim_1')).rejects.toThrow('socket hang up');
    expect(keys.data.has(SIM_KEYS.reset('sim_1'))).toBe(false);
    expect(h.writeAudit.mock.calls[0]?.[1]).toMatchObject({ notes: 'SimNetworkReset (failed)' });
  });
});

describe('refreshStationSimProvider lock', () => {
  it('renews the lock before every provider call and releases it', async () => {
    const keys = new MemoryKeyStore();
    const { ctx } = context(keys, fakeProvider(TWO_PAGES));
    const result = await refreshStationSimProvider(ctx, 'sta_1', PERIOD);
    expect(result).toMatchObject({ result: 'ok', sessionsStored: 3 });
    expect(events).toEqual([
      'acquire',
      'renew',
      'getStatus',
      'renew',
      'listSessions',
      'renew',
      'listSessions',
      'renew',
      'listAlerts',
      'renew',
      'release',
    ]);
    expect(keys.data.has(LOCK)).toBe(false);
    // Synced up to the period end, the end the coverage records, so the cursor stays usable.
    expect(mockSessionsSynced).toHaveBeenCalledWith('sim_1', '4001', '30', PERIOD.to);
    expect(mockAlertsSynced).toHaveBeenCalledWith('sim_1', '4001', expect.any(Date));
    expect(mockStatus).toHaveBeenCalledWith('sim_1', '4001', expect.any(Object), expect.any(Date));
  });

  it('writes no cursor, synced time or coverage when the lock is lost after the last provider call', async () => {
    const keys = new MemoryKeyStore();
    // Status, two session pages, alerts, then the check before the closing writes.
    keys.renewResults = [true, true, true, true, false];
    const { ctx } = context(keys, fakeProvider(TWO_PAGES));
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'lock_lost',
    });
    expect(mockSessionsSynced).not.toHaveBeenCalled();
    expect(mockAlertsSynced).not.toHaveBeenCalled();
    expect(inserted.get('sim_fetch_coverage')).toBeUndefined();
  });

  it('stops after the current call when a renewal fails, with no coverage and the cursor kept', async () => {
    const keys = new MemoryKeyStore();
    keys.renewResults = [true, true, false];
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    const result = await refreshStationSimProvider(ctx, 'sta_1', PERIOD);
    expect(result).toEqual({ result: 'failed', kind: 'lock_lost' });
    expect(provider.listSessions).toHaveBeenCalledTimes(1);
    expect(provider.listAlerts).not.toHaveBeenCalled();
    expect(inserted.get('sim_fetch_coverage')).toBeUndefined();
    expect(mockSessionsSynced).not.toHaveBeenCalled();
    expect(mockAlertsSynced).not.toHaveBeenCalled();
  });

  it('treats a renewal that throws as a lost lock', async () => {
    const keys = new MemoryKeyStore();
    keys.renew = vi.fn().mockRejectedValue(new Error('NOPERM'));
    const provider = fakeProvider(TWO_PAGES);
    const { ctx, log } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'lock_lost',
    });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1' }),
      expect.any(String),
    );
  });

  it('releases only its own token after another Refresh took over the expired lock', async () => {
    const keys = new MemoryKeyStore();
    let renewals = 0;
    keys.onRenew = () => {
      renewals += 1;
      if (renewals === 2) keys.data.set(LOCK, 'other-refresh');
    };
    const { ctx } = context(keys, fakeProvider(TWO_PAGES));
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'lock_lost',
    });
    expect(keys.data.get(LOCK)).toBe('other-refresh');
  });

  it('skips with in_progress while another Refresh holds the lock', async () => {
    const keys = new MemoryKeyStore();
    keys.data.set(LOCK, 'other-refresh');
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'in_progress',
    });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(keys.data.get(LOCK)).toBe('other-refresh');
  });
});

describe('refreshStationSimProvider Redis failures', () => {
  it('reports the provider part unavailable when the lock cannot be taken', async () => {
    const keys = new MemoryKeyStore();
    keys.acquire = vi.fn().mockRejectedValue(new Error('connection lost'));
    const provider = fakeProvider(TWO_PAGES);
    const { ctx, log } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'unavailable',
    });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1' }),
      expect.any(String),
    );
  });

  it('reports the provider part unavailable when the backoff cannot be read', async () => {
    const keys = new MemoryKeyStore();
    keys.ttlSeconds = vi.fn().mockRejectedValue(new Error('connection lost'));
    const provider = fakeProvider(TWO_PAGES);
    const { ctx, log } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'unavailable',
    });
    expect(events).not.toContain('acquire');
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1' }),
      expect.any(String),
    );
  });

  it('keeps the reply when the release fails', async () => {
    const keys = new MemoryKeyStore();
    keys.release = vi.fn().mockRejectedValue(new Error('connection lost'));
    const { ctx, log } = context(keys, fakeProvider(TWO_PAGES));
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toMatchObject({
      result: 'ok',
      sessionsStored: 3,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1' }),
      expect.any(String),
    );
  });

  it('still reports the rate limit when the backoff cannot be stored', async () => {
    const keys = new MemoryKeyStore();
    keys.setFor = vi.fn().mockRejectedValue(new Error('connection lost'));
    const provider = fakeProvider(TWO_PAGES);
    vi.mocked(provider.getStatus).mockRejectedValue(
      new SimProviderError('rate_limited', 'slow down', { retryAfterSeconds: 30 }),
    );
    const { ctx, log } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'rate_limited',
      retryAfter: 30,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ simId: 'sim_1' }),
      expect.stringContaining('backoff'),
    );
  });
});

describe('refreshStationSimProvider paging', () => {
  it('stores what the provider returns for the period and pages while it continues', async () => {
    // The provider query is bounded by the period (Hologram: session end at or
    // after timestart), so a session that began before the period still ended
    // in it and is stored, and paging follows the provider.
    const keys = new MemoryKeyStore();
    const pages = [
      [session(30, new Date(PERIOD.from.getTime() - 3_600_000))],
      [session(29, new Date(PERIOD.from.getTime() - 2 * 3_600_000))],
    ];
    const provider = fakeProvider(pages);
    const { ctx } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toMatchObject({
      result: 'ok',
      sessionsStored: 2,
    });
    expect(provider.listSessions).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.listSessions).mock.calls[0]?.[1]).toEqual({
      range: { from: PERIOD.from, to: PERIOD.to },
    });
  });
});
