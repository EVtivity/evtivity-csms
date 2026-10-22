// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, mockGetMatch, mockSetMatch, mockMiss, stationRow } = vi.hoisted(() => {
  const stationRow: { iccid: string | null } = { iccid: '8901260000000000001F' };
  const chain = {
    from: () => chain,
    where: () => Promise.resolve([stationRow]),
  };
  return {
    stationRow,
    db: { select: vi.fn(() => chain) },
    mockGetMatch: vi.fn(),
    mockSetMatch: vi.fn(),
    mockMiss: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db,
  chargingStations: { iccid: 'iccid', id: 'id' },
  getSimProviderSettings: vi.fn(),
  getStationSimMatch: mockGetMatch,
  setStationSimMatch: mockSetMatch,
  recordSimLookupMiss: mockMiss,
  confirmStationSimMatch: vi.fn(),
  clearStationSimMatch: vi.fn(),
}));

import type { SimProvider } from '@evtivity/sim-providers';
import {
  resolveStationSim,
  simRefreshPeriod,
  SIM_LOOKUP_MISS_TTL_MS,
  storedSimStatus,
} from '../station-sim.service.js';

const ACTOR = { actor: 'operator' as const, actorUserId: 'usr_1' };

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
  } as unknown as Parameters<typeof resolveStationSim>[0];
}

function match(fields: Record<string, unknown>) {
  return {
    stationId: 'sta_1',
    provider: null,
    providerRef: null,
    meta: null,
    enteredIccid: null,
    enteredBy: null,
    enteredWithAllSites: false,
    confirmedAt: null,
    lookupMissedAt: null,
    lookupMissReason: null,
    ...fields,
  };
}

beforeEach(() => {
  stationRow.iccid = '8901260000000000001F';
  mockGetMatch.mockResolvedValue(null);
  mockSetMatch.mockResolvedValue({ matched: true });
});

describe('resolveStationSim', () => {
  it('reuses a stored match without a lookup', async () => {
    const provider = fakeProvider(null);
    mockGetMatch.mockResolvedValue(
      match({
        provider: 'hologram',
        providerRef: '4001',
        meta: { linkId: '5001' },
        confirmedAt: new Date(),
      }),
    );
    const result = await resolveStationSim(registry([provider]), 'sta_1', ACTOR);
    expect(result).toMatchObject({
      kind: 'matched',
      ref: { providerSimId: '4001', linkId: '5001' },
      confirmed: true,
    });
    expect(provider.findByIccid).not.toHaveBeenCalled();
  });

  it('answers provider_off with no provider on, before reading the ICCID', async () => {
    expect(await resolveStationSim(registry([]), 'sta_1', ACTOR)).toEqual({ kind: 'provider_off' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks up the normalized ICCID and stores an unconfirmed match', async () => {
    const provider = fakeProvider({ providerSimId: '4001', linkId: '5001' });
    const result = await resolveStationSim(registry([provider]), 'sta_1', ACTOR);
    expect(provider.findByIccid).toHaveBeenCalledWith('8901260000000000001');
    expect(result).toMatchObject({ kind: 'matched', confirmed: false });
    expect(mockSetMatch).toHaveBeenCalledWith(
      'sta_1',
      { provider: 'hologram', providerRef: '4001', meta: { linkId: '5001' }, confirm: null },
      ACTOR,
      undefined,
    );
  });

  it('confirms a hit on the ICCID an operator with every site entered, for that operator', async () => {
    mockGetMatch.mockResolvedValue(
      match({
        enteredIccid: '8901260000000000001',
        enteredBy: 'usr_entered',
        enteredWithAllSites: true,
      }),
    );
    const provider = fakeProvider({ providerSimId: '4001' });
    const result = await resolveStationSim(registry([provider]), 'sta_1', ACTOR);
    expect(result).toMatchObject({ kind: 'matched', confirmed: true });
    expect(mockSetMatch.mock.calls[0]?.[1]).toMatchObject({ confirm: { by: 'usr_entered' } });
  });

  it('leaves a hit unconfirmed when the ICCID was entered without access to every site', async () => {
    mockGetMatch.mockResolvedValue(
      match({ enteredIccid: '8901260000000000001', enteredBy: 'usr_site' }),
    );
    const result = await resolveStationSim(
      registry([fakeProvider({ providerSimId: '4001' })]),
      'sta_1',
      ACTOR,
    );
    expect(result).toMatchObject({ kind: 'matched', confirmed: false });
    expect(mockSetMatch.mock.calls[0]?.[1]).toMatchObject({ confirm: null });
  });

  it('refuses a SIM matched to another station', async () => {
    mockSetMatch.mockResolvedValue({ matched: false, reason: 'sim_matched_elsewhere' });
    const result = await resolveStationSim(
      registry([fakeProvider({ providerSimId: '4001' })]),
      'sta_1',
      ACTOR,
    );
    expect(result).toEqual({ kind: 'not_matched', reason: 'sim_matched_elsewhere' });
  });

  it('caches a miss for an hour unless the lookup is retried', async () => {
    const provider = fakeProvider(null);
    expect(await resolveStationSim(registry([provider]), 'sta_1', ACTOR)).toEqual({
      kind: 'not_matched',
      reason: 'not_found',
    });
    expect(mockMiss).toHaveBeenCalledWith('sta_1', 'not_found');

    mockGetMatch.mockResolvedValue(
      match({ lookupMissedAt: new Date(Date.now() - 60_000), lookupMissReason: 'not_found' }),
    );
    vi.mocked(provider.findByIccid).mockClear();
    await resolveStationSim(registry([provider]), 'sta_1', ACTOR);
    expect(provider.findByIccid).not.toHaveBeenCalled();

    await resolveStationSim(registry([provider]), 'sta_1', ACTOR, { retryLookup: true });
    expect(provider.findByIccid).toHaveBeenCalledTimes(1);

    mockGetMatch.mockResolvedValue(
      match({ lookupMissedAt: new Date(Date.now() - SIM_LOOKUP_MISS_TTL_MS - 1000) }),
    );
    await resolveStationSim(registry([provider]), 'sta_1', ACTOR);
    expect(provider.findByIccid).toHaveBeenCalledTimes(2);
  });

  it('answers no_iccid for a station without a valid ICCID', async () => {
    stationRow.iccid = null;
    expect(await resolveStationSim(registry([fakeProvider(null)]), 'sta_1', ACTOR)).toEqual({
      kind: 'not_matched',
      reason: 'no_iccid',
    });
  });

  it('answers provider_off when the stored match belongs to a provider now off', async () => {
    mockGetMatch.mockResolvedValue(match({ provider: 'hologram', providerRef: '4001' }));
    expect(await resolveStationSim(registry([]), 'sta_1', ACTOR)).toEqual({ kind: 'provider_off' });
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
