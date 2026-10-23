// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock('@evtivity/database', () => ({
  db: {},
  getSimProviderSettings: vi.fn(),
  recordSimLookup: mockLookup,
}));
vi.mock('../sim-inventory.service.js', () => ({ attachReportedStationSim: vi.fn() }));

import type { Sim } from '@evtivity/database';
import type { SimProvider } from '@evtivity/sim-providers';
import {
  resolveSimProvider,
  simRefOf,
  simRefreshPeriod,
  SIM_KEYS,
  SIM_LOOKUP_MISS_TTL_MS,
  storedSimStatus,
} from '../station-sim.service.js';

const ICCID = '8901260000000000001';

function fakeProvider(found: { providerSimId: string; linkId?: string } | null): SimProvider {
  return {
    id: 'hologram',
    findByIccid: vi.fn().mockResolvedValue(found),
  } as unknown as SimProvider;
}

function registry(providers: SimProvider[]) {
  return {
    enabledProviders: vi.fn().mockResolvedValue(providers),
    getProvider: vi.fn((id: string) => Promise.resolve(providers.find((p) => p.id === id) ?? null)),
  } as unknown as Parameters<typeof resolveSimProvider>[0];
}

function sim(fields: Partial<Sim> = {}): Sim {
  return {
    id: 'sim_1',
    iccid: ICCID,
    provider: null,
    providerRef: null,
    providerMeta: null,
    lookupMissedAt: null,
    lookupMissReason: null,
    status: 'active',
    ...fields,
  } as Sim;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLookup.mockResolvedValue('recorded');
});

describe('SIM_KEYS', () => {
  it('keys the fetch lock and the reset cooldown per SIM, the Refresh limit per target', () => {
    expect(SIM_KEYS.lock('sim_1')).toBe('sim:lock:sim_1');
    expect(SIM_KEYS.reset('sim_1')).toBe('sim:reset:sim_1');
    expect(SIM_KEYS.refresh('sta_1')).toBe('sim:refresh:sta_1');
    expect(SIM_KEYS.refresh('sim_1')).toBe('sim:refresh:sim_1');
    expect(SIM_KEYS.signalRead('sta_1')).toBe('sim:signalread:sta_1');
    for (const key of [SIM_KEYS.backoff('hologram'), SIM_KEYS.test('hologram')]) {
      expect(key.startsWith('sim:')).toBe(true);
    }
  });
});

describe('simRefOf', () => {
  it('reads the provider SIM and its other ids from the SIM row', () => {
    expect(simRefOf({ providerRef: '4001', providerMeta: { linkId: '5001', other: 1 } })).toEqual({
      providerSimId: '4001',
      linkId: '5001',
    });
    expect(simRefOf({ providerRef: null, providerMeta: null })).toBeNull();
  });
});

describe('resolveSimProvider', () => {
  it('reuses the stored provider SIM without a lookup', async () => {
    const provider = fakeProvider(null);
    const result = await resolveSimProvider(
      registry([provider]),
      sim({ provider: 'hologram', providerRef: '4001', providerMeta: { linkId: '5001' } }),
    );
    expect(result).toMatchObject({
      kind: 'found',
      ref: { providerSimId: '4001', linkId: '5001' },
    });
    expect(provider.findByIccid).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('answers provider_off with no provider on, writing nothing', async () => {
    expect(await resolveSimProvider(registry([]), sim())).toEqual({ kind: 'provider_off' });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('answers provider_off when the stored provider is now off', async () => {
    expect(
      await resolveSimProvider(registry([]), sim({ provider: 'hologram', providerRef: '4001' })),
    ).toEqual({ kind: 'provider_off' });
  });

  it('looks the ICCID up and stores the hit on the SIM', async () => {
    const provider = fakeProvider({ providerSimId: '4001', linkId: '5001' });
    const result = await resolveSimProvider(registry([provider]), sim());
    expect(provider.findByIccid).toHaveBeenCalledWith(ICCID);
    expect(result).toMatchObject({ kind: 'found', ref: { providerSimId: '4001' } });
    expect(mockLookup).toHaveBeenCalledWith('sim_1', {
      provider: 'hologram',
      providerRef: '4001',
      meta: { linkId: '5001' },
    });
  });

  it('records a miss after the last provider when another SIM row holds the hit', async () => {
    mockLookup.mockResolvedValueOnce('ref_held_elsewhere');
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const result = await resolveSimProvider(
      registry([fakeProvider({ providerSimId: '4001' })]),
      sim(),
      { log },
    );
    expect(result).toEqual({ kind: 'not_found' });
    expect(mockLookup).toHaveBeenLastCalledWith('sim_1', { miss: 'not_found' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('asks the next provider after a hit another SIM row holds (ref_held_elsewhere)', async () => {
    const first = {
      ...fakeProvider({ providerSimId: '4001' }),
      id: 'first',
    } as unknown as SimProvider;
    const second = fakeProvider({ providerSimId: '9001' });
    mockLookup.mockResolvedValueOnce('ref_held_elsewhere').mockResolvedValueOnce('recorded');
    const result = await resolveSimProvider(registry([first, second]), sim());
    expect(result).toMatchObject({
      kind: 'found',
      provider: second,
      ref: { providerSimId: '9001' },
    });
    expect(second.findByIccid).toHaveBeenCalledWith(ICCID);
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(mockLookup).not.toHaveBeenCalledWith('sim_1', { miss: 'not_found' });
  });

  it('caches a miss for an hour unless the lookup is retried', async () => {
    const provider = fakeProvider(null);
    expect(await resolveSimProvider(registry([provider]), sim())).toEqual({ kind: 'not_found' });
    expect(mockLookup).toHaveBeenCalledWith('sim_1', { miss: 'not_found' });

    const missed = sim({ lookupMissedAt: new Date(Date.now() - 60_000) });
    vi.mocked(provider.findByIccid).mockClear();
    await resolveSimProvider(registry([provider]), missed);
    expect(provider.findByIccid).not.toHaveBeenCalled();

    await resolveSimProvider(registry([provider]), missed, { retryLookup: true });
    expect(provider.findByIccid).toHaveBeenCalledTimes(1);

    await resolveSimProvider(
      registry([provider]),
      sim({ lookupMissedAt: new Date(Date.now() - SIM_LOOKUP_MISS_TTL_MS - 1000) }),
    );
    expect(provider.findByIccid).toHaveBeenCalledTimes(2);
  });
});

describe('simRefreshPeriod', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const bounds = { now, historyDays: 90, retentionDays: 60 };
  const DAY = 86_400_000;

  it('takes an offered day count up to now', () => {
    expect(simRefreshPeriod({ days: 7 }, bounds)).toEqual({
      mode: 'days',
      from: new Date(now.getTime() - 7 * DAY),
      to: now,
    });
  });

  const refusals: Array<
    [
      { days: number } | { from: Date; to: Date },
      string,
      { now: Date; historyDays: number | null; retentionDays: number },
    ]
  > = [
    [{ days: 5 }, 'days_not_offered', bounds],
    [{ days: 31 }, 'before_retention', { ...bounds, retentionDays: 14 }],
    [{ days: 31 }, 'before_history_window', { ...bounds, historyDays: 7 }],
    [{ from: new Date(now.getTime() - 40 * DAY), to: now }, 'range_too_long', bounds],
    [{ from: now, to: new Date(now.getTime() - DAY) }, 'range_reversed', bounds],
    [
      { from: new Date(now.getTime() - DAY), to: new Date(now.getTime() + 3_600_000) },
      'in_future',
      bounds,
    ],
    [
      { from: new Date(now.getTime() - 70 * DAY), to: new Date(now.getTime() - 69 * DAY) },
      'before_retention',
      bounds,
    ],
    [
      { from: new Date(now.getTime() - 20 * DAY), to: new Date(now.getTime() - 19 * DAY) },
      'before_history_window',
      { ...bounds, historyDays: 14 },
    ],
  ];

  it.each(refusals)('refuses %j with %s', (request, reason, limits) => {
    let caught: unknown;
    try {
      simRefreshPeriod(request, limits);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toMatchObject({ reason });
  });

  it('takes a range and caps its end at now', () => {
    const from = new Date(now.getTime() - 3 * DAY);
    const to = new Date(now.getTime() + 30_000);
    expect(simRefreshPeriod({ from, to }, bounds)).toEqual({ mode: 'range', from, to: now });
  });
});

describe('storedSimStatus', () => {
  it('keeps only the allow-listed fields', () => {
    const stored = storedSimStatus({
      providerSimId: '4001',
      iccid: '8900000000000000300',
      imsi: '310260000004001',
      state: 'active',
      providerState: 'LIVE',
      inSession: true,
      openSessionBeganAt: '2026-10-21T10:00:00.000Z',
      apn: 'hologram',
      profileName: 'Global-3',
      lastSessionAt: null,
      usage: { bytes: 10, periodEnd: null, limitBytes: null },
    });
    expect(JSON.stringify(stored)).not.toContain('8900000000000000300');
    expect(JSON.stringify(stored)).not.toContain('310260000004001');
    expect(JSON.stringify(stored)).not.toContain('4001');
    expect(stored.usage).toEqual({ bytes: 10, periodEnd: null, limitBytes: null });
  });
});
