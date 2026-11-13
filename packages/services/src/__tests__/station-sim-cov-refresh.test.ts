// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SIM page Refresh and the network reset of the station SIM service:
// the session cursor with stored coverage, alert paging, provider errors,
// Redis failures around the lock and the cooldown, and the reset audit.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  getSim: vi.fn(),
  lookup: vi.fn(),
  status: vi.fn(),
  sessionsSynced: vi.fn(),
  alertsSynced: vi.fn(),
  audits: [] as Record<string, unknown>[],
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSim: h.getSim,
    getSimProviderSettings: vi.fn(),
    recordSimLookup: h.lookup,
    recordSimStatus: h.status,
    recordSimSessionsSynced: h.sessionsSynced,
    recordSimAlertsSynced: h.alertsSynced,
    writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
      h.audits.push(args);
      return Promise.resolve();
    },
    compareRecordIds: (a: string, b: string) => Number(a) - Number(b),
  });
});
vi.mock('../sim-inventory.service.js', () => ({ attachReportedStationSim: vi.fn() }));

import {
  SimProviderError,
  type SimAlert,
  type SimProvider,
  type SimSession,
} from '@evtivity/sim-providers';
import {
  refreshSimProvider,
  resetSimNetwork,
  SIM_DEFAULT_BACKOFF_SECONDS,
  SIM_KEYS,
  SIM_RESET_COOLDOWN_SECONDS,
  type SimRefreshContext,
  type SimRefreshPeriod,
  type SimResetContext,
} from '../station-sim.service.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD: SimRefreshPeriod = { mode: 'days', from: new Date(NOW.getTime() - 7 * DAY), to: NOW };

function simRow(fields: Record<string, unknown> = {}) {
  return {
    id: 'sim_1',
    iccid: '8901260000000000001',
    provider: 'hologram',
    providerRef: '4001',
    providerMeta: null,
    lookupMissedAt: null,
    lastRecordId: null,
    sessionsSyncedAt: null,
    status: 'active',
    ...fields,
  };
}

function session(id: number, startedAt: Date): SimSession {
  return {
    providerSessionId: String(id),
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + 60_000).toISOString(),
    bytes: 1,
    networkName: null,
    radioAccessTechnology: null,
    cellId: null,
    apn: null,
  };
}

function alert(id: number): SimAlert {
  return {
    providerAlertId: String(id),
    kind: 'data_limit',
    receivedAt: new Date(NOW.getTime() - HOUR).toISOString(),
  } as unknown as SimAlert;
}

interface KeyOptions {
  acquire?: () => Promise<boolean>;
  release?: () => Promise<void>;
  ttl?: () => Promise<number | null>;
  setFor?: () => Promise<void>;
}

function keys(o: KeyOptions = {}) {
  return {
    acquire: vi.fn(o.acquire ?? (() => Promise.resolve(true))),
    renew: vi.fn(() => Promise.resolve(true)),
    release: vi.fn(o.release ?? (() => Promise.resolve())),
    ttlSeconds: vi.fn(o.ttl ?? (() => Promise.resolve(null))),
    setFor: vi.fn(o.setFor ?? (() => Promise.resolve())),
    increment: vi.fn(() => Promise.resolve(1)),
  };
}

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function provider(fields: Record<string, unknown> = {}): SimProvider {
  return {
    id: 'hologram',
    historyDays: 90,
    reportingDelayHours: 6,
    capabilities: { networkReset: true },
    findByIccid: vi.fn(),
    getStatus: vi.fn(() =>
      Promise.resolve({
        providerSimId: '4001',
        state: 'active',
        providerState: 'LIVE',
        inSession: false,
        openSessionBeganAt: null,
        apn: null,
        profileName: null,
        lastSessionAt: null,
        usage: null,
      }),
    ),
    listSessions: vi.fn(() => Promise.resolve({ items: [], continues: false, lastId: null })),
    listAlerts: vi.fn(() => Promise.resolve({ items: [], continues: false, lastId: null })),
    resetNetwork: vi.fn(() => Promise.resolve({ status: 'accepted' })),
    ...fields,
  } as unknown as SimProvider;
}

function refreshCtx(p: SimProvider, k = keys()): SimRefreshContext {
  return {
    registry: {
      enabledProviders: vi.fn().mockResolvedValue([p]),
      getProvider: vi.fn().mockResolvedValue(p),
    } as unknown as SimRefreshContext['registry'],
    keys: k,
    actor: { actor: 'operator', actorUserId: 'usr_1' },
    log,
    now: () => NOW,
  };
}

function resetCtx(p: SimProvider | null, k = keys()): SimResetContext {
  return {
    registry: {
      getProvider: vi.fn().mockResolvedValue(p),
    } as unknown as SimResetContext['registry'],
    keys: k,
    actor: { actor: 'operator', actorUserId: 'usr_1' },
    log,
  };
}

beforeEach(() => {
  h.fake.reset();
  h.audits.length = 0;
  vi.clearAllMocks();
  h.getSim.mockResolvedValue(simRow());
  h.lookup.mockResolvedValue('recorded');
});

describe('refreshSimProvider: the cursor and alerts', () => {
  it('stops paging at the cursor when stored coverage holds the rest of the period', async () => {
    const synced = new Date(NOW.getTime() - DAY);
    h.getSim.mockResolvedValue(simRow({ lastRecordId: '28', sessionsSyncedAt: synced }));
    h.fake.queue('select:sim_fetch_coverage', [
      { from: new Date(PERIOD.from.getTime() - DAY), to: NOW },
    ]);
    h.fake.always('insert:sim_sessions', [{ id: 1 }, { id: 2 }]);
    const p = provider({
      listSessions: vi.fn(() =>
        Promise.resolve({
          items: [
            session(30, new Date(NOW.getTime() - HOUR)),
            session(29, new Date(NOW.getTime() - 2 * HOUR)),
            session(28, new Date(NOW.getTime() - 3 * HOUR)),
          ],
          continues: true,
          lastId: '28',
        }),
      ),
    });
    const out = await refreshSimProvider(refreshCtx(p), 'sim_1', PERIOD);
    expect(out).toMatchObject({ result: 'ok', sessionsStored: 2 });
    expect(p.listSessions).toHaveBeenCalledTimes(1);
    const values = h.fake.find('insert', 'sim_sessions')[0]!.values as {
      providerSessionId: string;
    }[];
    expect(values.map((v) => v.providerSessionId)).toEqual(['30', '29']);
    expect(h.sessionsSynced).toHaveBeenCalledWith('sim_1', '4001', '30', NOW);
  });

  it('pages back past the cursor when coverage does not hold the period', async () => {
    h.getSim.mockResolvedValue(
      simRow({ lastRecordId: '28', sessionsSyncedAt: new Date(NOW.getTime() - DAY) }),
    );
    const p = provider({
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({
          items: [session(30, NOW), session(28, NOW)],
          continues: true,
          lastId: '28',
        })
        .mockResolvedValueOnce({ items: [], continues: false, lastId: null }),
    });
    await refreshSimProvider(refreshCtx(p), 'sim_1', PERIOD);
    expect(p.listSessions).toHaveBeenCalledTimes(2);
    expect(p.listSessions).toHaveBeenLastCalledWith(
      { providerSimId: '4001' },
      { startAfter: '28', range: { from: PERIOD.from, to: PERIOD.to } },
    );
  });

  it('ignores the cursor of another provider SIM and in range mode', async () => {
    h.getSim
      .mockResolvedValueOnce(simRow())
      .mockResolvedValueOnce(simRow())
      .mockResolvedValueOnce(
        simRow({ providerRef: '9999', lastRecordId: '1', sessionsSyncedAt: NOW }),
      );
    const p = provider();
    const out = await refreshSimProvider(refreshCtx(p), 'sim_1', { ...PERIOD, mode: 'range' });
    expect(out).toMatchObject({ result: 'ok' });
    // A range Refresh moves no synced marks.
    expect(h.sessionsSynced).not.toHaveBeenCalled();
    expect(h.alertsSynced).not.toHaveBeenCalled();
    // No cursor check: the only coverage read is the write's own merge.
    expect(h.fake.find('select', 'sim_fetch_coverage').every((c) => c.inTx)).toBe(true);
  });

  it('stores alerts of every page, at most one insert per page chunk', async () => {
    h.fake.always('insert:sim_alerts', [{ id: 1 }]);
    const p = provider({
      listAlerts: vi
        .fn()
        .mockResolvedValueOnce({ items: [alert(1), alert(2)], continues: true, lastId: '2' })
        .mockResolvedValueOnce({ items: [alert(3)], continues: false, lastId: '3' }),
    });
    const out = await refreshSimProvider(refreshCtx(p), 'sim_1', PERIOD);
    expect(out).toMatchObject({ result: 'ok', alertsStored: 2 });
    expect(p.listAlerts).toHaveBeenLastCalledWith(
      { providerSimId: '4001' },
      { startAfter: '2', range: { from: PERIOD.from, to: PERIOD.to } },
    );
    const inserts = h.fake.find('insert', 'sim_alerts');
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toEqual([
      expect.objectContaining({ simId: 'sim_1', provider: 'hologram', providerAlertId: '1' }),
      expect.objectContaining({ providerAlertId: '2' }),
    ]);
    expect(h.alertsSynced).toHaveBeenCalledWith('sim_1', '4001', NOW);
  });
});

describe('refreshSimProvider: errors', () => {
  it('backs off the provider for the default wait and reports it when the store fails', async () => {
    const k = keys({ setFor: () => Promise.reject(new Error('redis')) });
    const p = provider({
      getStatus: vi.fn(() => Promise.reject(new SimProviderError('rate_limited', 'slow down'))),
    });
    const out = await refreshSimProvider(refreshCtx(p, k), 'sim_1', PERIOD);
    expect(out).toEqual({
      result: 'failed',
      kind: 'rate_limited',
      retryAfter: SIM_DEFAULT_BACKOFF_SECONDS,
    });
    expect(k.setFor).toHaveBeenCalledWith(
      SIM_KEYS.backoff('hologram'),
      SIM_DEFAULT_BACKOFF_SECONDS,
    );
    expect(k.release).toHaveBeenCalled();
  });

  it('reports any other provider error kind', async () => {
    const p = provider({
      getStatus: vi.fn(() => Promise.reject(new SimProviderError('auth', 'no'))),
    });
    expect(await refreshSimProvider(refreshCtx(p), 'sim_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'auth',
    });
  });

  it('rethrows an error that is not a provider error and still releases the lock', async () => {
    const k = keys();
    const p = provider({ getStatus: vi.fn(() => Promise.reject(new Error('db down'))) });
    await expect(refreshSimProvider(refreshCtx(p, k), 'sim_1', PERIOD)).rejects.toThrow('db down');
    expect(k.release).toHaveBeenCalledWith(SIM_KEYS.lock('sim_1'), expect.any(String));
  });

  it('answers the lookup result when the SIM is not found at the provider', async () => {
    h.getSim.mockResolvedValue(simRow({ provider: null, providerRef: null }));
    const p = provider({ findByIccid: vi.fn(() => Promise.resolve(null)) });
    expect(await refreshSimProvider(refreshCtx(p), 'sim_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'not_found',
    });
    expect(h.lookup).toHaveBeenCalledWith('sim_1', { miss: 'not_found' });
  });
});

describe('resetSimNetwork', () => {
  it('refuses a SIM never looked up, and one whose provider is off', async () => {
    h.getSim.mockResolvedValueOnce(simRow({ providerRef: null }));
    expect(await resetSimNetwork(resetCtx(provider()), 'sim_1')).toEqual({ kind: 'not_looked_up' });
    expect(await resetSimNetwork(resetCtx(null), 'sim_1')).toEqual({ kind: 'provider_off' });
    h.getSim.mockResolvedValueOnce(null);
    expect(await resetSimNetwork(resetCtx(provider()), 'sim_1')).toEqual({ kind: 'sim_not_found' });
  });

  it('answers the cooldown wait, the full wait when Redis has none or cannot say', async () => {
    const busy = (ttl: () => Promise<number | null>) =>
      keys({ acquire: () => Promise.resolve(false), ttl });
    expect(
      await resetSimNetwork(
        resetCtx(
          provider(),
          busy(() => Promise.resolve(17)),
        ),
        'sim_1',
      ),
    ).toEqual({
      kind: 'cooldown',
      retryAfter: 17,
    });
    expect(
      await resetSimNetwork(
        resetCtx(
          provider(),
          busy(() => Promise.resolve(null)),
        ),
        'sim_1',
      ),
    ).toEqual({
      kind: 'cooldown',
      retryAfter: SIM_RESET_COOLDOWN_SECONDS,
    });
    expect(
      await resetSimNetwork(
        resetCtx(
          provider(),
          busy(() => Promise.reject(new Error('r'))),
        ),
        'sim_1',
      ),
    ).toEqual({ kind: 'cooldown', retryAfter: SIM_RESET_COOLDOWN_SECONDS });
  });

  it('gives the cooldown back and rethrows when the access recheck fails', async () => {
    const k = keys({ release: () => Promise.reject(new Error('redis')) });
    const p = provider();
    await expect(
      resetSimNetwork(resetCtx(p, k), 'sim_1', {
        stillAllowed: () => Promise.reject(new Error('db')),
      }),
    ).rejects.toThrow('db');
    expect(k.release).toHaveBeenCalledWith(SIM_KEYS.reset('sim_1'), expect.any(String));
    expect(p.resetNetwork).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('answers sim_not_found when the SIM was deleted after the cooldown', async () => {
    h.getSim.mockResolvedValueOnce(simRow()).mockResolvedValueOnce(null);
    const p = provider();
    expect(await resetSimNetwork(resetCtx(p), 'sim_1')).toEqual({ kind: 'sim_not_found' });
    expect(p.resetNetwork).not.toHaveBeenCalled();
  });

  it('audits an accepted reset with the attached station', async () => {
    h.fake.queue('select:sim_attachments', [{ stationId: 'sta_1' }]);
    const onOutcome = vi.fn(() => Promise.resolve());
    expect(await resetSimNetwork(resetCtx(provider()), 'sim_1', { onOutcome })).toEqual({
      kind: 'reset',
      status: 'accepted',
    });
    expect(h.audits[0]).toMatchObject({
      action: 'network_reset',
      actor: 'operator',
      after: { outcome: 'accepted', stationId: 'sta_1' },
      notes: 'SimNetworkReset (accepted)',
    });
    expect(onOutcome).toHaveBeenCalledWith('accepted', 'sta_1');
  });

  it('marks the station unknown when the attachment cannot be read', async () => {
    h.fake.fail('select:sim_attachments', new Error('db'));
    await resetSimNetwork(resetCtx(provider()), 'sim_1');
    expect(h.audits[0]!['after']).toEqual({
      outcome: 'accepted',
      stationId: null,
      stationUnknown: true,
    });
  });

  it('keeps the provider error when the backoff after a 429 cannot be stored', async () => {
    const k = keys({ setFor: () => Promise.reject(new Error('redis')) });
    const err = new SimProviderError('rate_limited', 'slow', { retryAfterSeconds: 120 });
    const p = provider({ resetNetwork: vi.fn(() => Promise.reject(err)) });
    expect(await resetSimNetwork(resetCtx(p, k), 'sim_1')).toEqual({
      kind: 'provider_error',
      error: err,
    });
    expect(k.setFor).toHaveBeenCalledWith(SIM_KEYS.backoff('hologram'), 120);
    expect(h.audits[0]!['after']).toMatchObject({ outcome: 'failed' });
  });

  it('backs off for the cooldown when the 429 names no wait', async () => {
    const k = keys();
    const p = provider({
      resetNetwork: vi.fn(() => Promise.reject(new SimProviderError('rate_limited', 'slow'))),
    });
    await resetSimNetwork(resetCtx(p, k), 'sim_1');
    expect(k.setFor).toHaveBeenCalledWith(SIM_KEYS.backoff('hologram'), SIM_RESET_COOLDOWN_SECONDS);
  });
});
