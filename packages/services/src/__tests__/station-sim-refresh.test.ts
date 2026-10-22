// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, inserted, mockGetMatch, mockSessionsSynced, mockAlertsSynced, mockStatus } = vi.hoisted(
  () => {
    const inserted = new Map<string, unknown[]>();
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
          onConflictDoNothing: () => ({ returning: () => done }),
          onConflictDoUpdate: () => ({ returning: () => done }),
          then: done.then.bind(done),
        };
      },
    }));
    const tx = { execute: vi.fn(), select: () => selectChain, delete: vi.fn(), insert };
    return {
      inserted,
      db: {
        select: vi.fn(() => selectChain),
        insert,
        transaction: vi.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      },
      mockGetMatch: vi.fn(),
      mockSessionsSynced: vi.fn(),
      mockAlertsSynced: vi.fn(),
      mockStatus: vi.fn(),
    };
  },
);

vi.mock('@evtivity/database', () => ({
  db,
  chargingStations: { name: 'charging_stations', iccid: 'iccid', id: 'id' },
  simSessions: { name: 'sim_sessions', provider: 'provider', providerSessionId: 'psid', id: 'id' },
  simAlerts: { name: 'sim_alerts', provider: 'provider', providerAlertId: 'paid', id: 'id' },
  simFetchCoverage: {
    name: 'sim_fetch_coverage',
    stationId: 'station_id',
    provider: 'provider',
    coveredFrom: 'covered_from',
    coveredTo: 'covered_to',
    id: 'id',
  },
  getSimProviderSettings: vi.fn(),
  getStationSimMatch: mockGetMatch,
  setStationSimMatch: vi.fn(),
  recordSimLookupMiss: vi.fn(),
  confirmStationSimMatch: vi.fn(),
  clearStationSimMatch: vi.fn(),
  recordSimStatus: mockStatus,
  recordSimSessionsSynced: mockSessionsSynced,
  recordSimAlertsSynced: mockAlertsSynced,
  compareRecordIds: (a: string, b: string) => Number(a) - Number(b),
}));

import { SimProviderError, type SimProvider, type SimSession } from '@evtivity/sim-providers';
import {
  refreshStationSimProvider,
  SIM_KEYS,
  type SimKeyStore,
  type SimRefreshContext,
  type SimRefreshPeriod,
} from '../station-sim.service.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const PERIOD: SimRefreshPeriod = {
  mode: 'days',
  from: new Date(NOW.getTime() - 7 * DAY),
  to: NOW,
};
const LOCK = SIM_KEYS.lock('sta_1');

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
  events = [];
  inserted.clear();
  mockGetMatch.mockResolvedValue({
    stationId: 'sta_1',
    provider: 'hologram',
    providerRef: '4001',
    meta: { linkId: '5001' },
    confirmedAt: new Date(NOW.getTime() - DAY),
    lastRecordId: null,
    sessionsSyncedAt: null,
  });
});

describe('refreshStationSimProvider confirmation', () => {
  it('fetches nothing for a match nobody with access to every site confirmed', async () => {
    mockGetMatch.mockResolvedValue({
      stationId: 'sta_1',
      provider: 'hologram',
      providerRef: '4001',
      meta: {},
      confirmedAt: null,
    });
    const keys = new MemoryKeyStore();
    const provider = fakeProvider(TWO_PAGES);
    const { ctx } = context(keys, provider);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'skipped',
      reason: 'not_confirmed',
      provider: 'hologram',
    });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.listSessions).not.toHaveBeenCalled();
    expect(provider.listAlerts).not.toHaveBeenCalled();
    expect(mockStatus).not.toHaveBeenCalled();
    expect(inserted.size).toBe(0);
    expect(keys.data.has(LOCK)).toBe(false);
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
    mockGetMatch.mockResolvedValue(null);
    const first = { ...fakeProvider([]), id: 'first' } as unknown as SimProvider;
    const second = fakeProvider([]);
    vi.mocked(second.findByIccid).mockRejectedValue(
      new SimProviderError('rate_limited', 'slow down', { retryAfterSeconds: 45 }),
    );
    const keys = new MemoryKeyStore();
    const { ctx } = context(keys, second);
    vi.mocked(ctx.registry.enabledProviders).mockResolvedValue([first, second]);
    const iccidRow = {
      from: () => iccidRow,
      where: () => Promise.resolve([{ iccid: '8944500102198304826' }]),
    };
    db.select.mockImplementationOnce(() => iccidRow as unknown as ReturnType<typeof db.select>);
    expect(await refreshStationSimProvider(ctx, 'sta_1', PERIOD)).toEqual({
      result: 'failed',
      kind: 'rate_limited',
      retryAfter: 45,
    });
    expect(keys.ttls.get(SIM_KEYS.backoff('hologram'))).toBe(45);
    expect(keys.ttls.has(SIM_KEYS.backoff('first'))).toBe(false);
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
    expect(mockSessionsSynced).toHaveBeenCalledWith('sta_1', '4001', '30', PERIOD.to);
    expect(mockAlertsSynced).toHaveBeenCalledWith('sta_1', '4001', expect.any(Date));
    expect(mockStatus).toHaveBeenCalledWith('sta_1', '4001', expect.any(Object), expect.any(Date));
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
      expect.objectContaining({ stationId: 'sta_1' }),
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
      expect.objectContaining({ stationId: 'sta_1' }),
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
      expect.objectContaining({ stationId: 'sta_1' }),
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
      expect.objectContaining({ stationId: 'sta_1' }),
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
      expect.objectContaining({ stationId: 'sta_1' }),
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
