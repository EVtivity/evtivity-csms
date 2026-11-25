// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  creditTransition,
  limitTransition,
  profiledLimit,
  type LimitRecord,
} from '@evtivity/lib/load-limit-state';
import { ENERGY_ASSET_CREDIT_MIN_TTL_SECONDS } from '@evtivity/lib/energy-supply';
import { LOAD_MANAGEMENT_CYCLE_MS } from '../load-management-send.js';
import {
  CREDIT_CLOCK_MARGIN_MS,
  creditReplacementEnd,
  drawBoundKw,
  isLimitReserved,
  entriesAfterConfigSave,
  entriesAfterFailures,
  entriesForCuts,
  entriesForRaises,
  limitReservations,
  defaultReleaseKey,
  evseDefaultMightKw,
  mightEnforceInWatts,
  mightEnforceKw,
  NO_CREDIT_LIMIT,
  parseAppliedAllocations,
  RaiseBasisChanged,
  retryStationIds,
  SendClassificationChanged,
  stationCredit,
  UNKNOWN_CREDIT,
  UNKNOWN_CREDIT_REPLACEMENT_MS,
  withExpiredConfirmationWaits,
  type AppliedAllocation,
  type LimitSendCommand,
  limitSettlesOnReplies,
} from '../load-limit-entries.js';
import type { StationPowerInfo } from '../load-management-model.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');

function accepted(kw: number, commandId = `cmd-${String(kw)}`): LimitRecord {
  return { state: 'accepted', commandId, sentKw: kw, mightKw: null };
}

function entry(
  id: string,
  limit: LimitRecord,
  extra: Partial<AppliedAllocation> = {},
): AppliedAllocation {
  return { stationId: id.toUpperCase(), stationDbId: id, allocatedKw: 10, limit, ...extra };
}

function station(id: string, extra: Partial<StationPowerInfo> = {}): StationPowerInfo {
  return {
    id,
    stationId: id.toUpperCase(),
    circuitId: 'c1',
    currentDrawKw: 0,
    maxPowerKw: 50,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    ...extra,
  } as StationPowerInfo;
}

function send(stationDbId: string, kw: number, commandId: string): LimitSendCommand {
  return { stationDbId, commandId, kw, target: 'station' };
}

describe('parseAppliedAllocations', () => {
  it('reads an entry without a record as unknown and keeps the refusals', () => {
    expect(
      parseAppliedAllocations([
        { stationId: 'A', stationDbId: 'a', allocatedKw: 7, rejectedUnits: ['W', 'kW'] },
      ]),
    ).toEqual([
      {
        stationId: 'A',
        stationDbId: 'a',
        allocatedKw: 7,
        rejectedUnits: ['W'],
        limit: { state: 'unknown', mightKw: null },
      },
    ]);
  });

  it('reads the EVSE records and drops a credit without a valid end', () => {
    const [parsed] =
      parseAppliedAllocations([
        {
          stationId: 'A',
          stationDbId: 'a',
          allocatedKw: 7,
          limit: accepted(7),
          credit: { limit: accepted(9), until: 'soon' },
          evses: [
            {
              sessionId: 's1',
              transactionId: 't1',
              evseNumber: 1,
              kind: 'ac',
              limitKw: 4,
              limitA: 6,
              phases: 3,
              rateUnit: 'A',
              limit: { state: 'lost', mightKw: 5 },
            },
          ],
        },
      ]) ?? [];
    expect(parsed?.credit).toBeUndefined();
    expect(parsed?.evses?.[0]?.limit).toEqual({ state: 'lost', mightKw: 5 });
  });
});

describe('mightEnforceKw', () => {
  it('is unlimited for no entry and no stored profile, else the stored profile', () => {
    expect(mightEnforceKw(undefined, { nowMs: NOW })).toBeNull();
    expect(
      mightEnforceKw(undefined, { nowMs: NOW, storedLimit: { limit: profiledLimit(11) } }),
    ).toBe(11);
  });

  it('ignores the stored profile once the station has an entry', () => {
    const unknown = entry('a', { state: 'unknown', mightKw: null });
    expect(
      mightEnforceKw(unknown, { nowMs: NOW, storedLimit: { limit: profiledLimit(11) } }),
    ).toBeNull();
  });

  it('counts a send in flight at the higher of what was sent and what it may hold', () => {
    const raised = limitTransition(accepted(5), { type: 'send', commandId: 'raise', kw: 11 });
    expect(mightEnforceKw(entry('a', raised), { nowMs: NOW })).toBe(11);
    // A cut back to 5 before the raise was answered: the station may still hold 11.
    const cut = limitTransition(raised, { type: 'send', commandId: 'cut', kw: 5 });
    expect(mightEnforceKw(entry('a', cut), { nowMs: NOW })).toBe(11);
    // The reply to the first send does not confirm the cut.
    const old = limitTransition(cut, { type: 'accepted', commandId: 'raise' });
    expect(mightEnforceKw(entry('a', old), { nowMs: NOW })).toBe(11);
    const done = limitTransition(cut, { type: 'accepted', commandId: 'cut' });
    expect(mightEnforceKw(entry('a', done), { nowMs: NOW })).toBe(5);
  });

  it('keeps the limit before a lost send for the next one', () => {
    // 20 accepted, 8 sent and lost, then 10 sent: the station may hold 20.
    const lost = limitTransition(
      limitTransition(accepted(20), { type: 'send', commandId: 'n', kw: 8 }),
      { type: 'timeout', commandId: 'n' },
    );
    const next = limitTransition(lost, { type: 'send', commandId: 'n1', kw: 10 });
    expect(mightEnforceKw(entry('a', next), { nowMs: NOW })).toBe(20);
    const ok = limitTransition(next, { type: 'accepted', commandId: 'n1' });
    expect(mightEnforceKw(entry('a', ok), { nowMs: NOW })).toBe(10);
  });

  it('counts a credit profile that may still hold above the stack level 1 limit', () => {
    const credited = entry('a', accepted(20), {
      credit: { limit: accepted(25), until: new Date(NOW + 30_000).toISOString() },
    });
    expect(mightEnforceKw(credited, { nowMs: NOW })).toBe(25);
    // A station clock may run up to a minute behind: the credit still counts then.
    expect(mightEnforceKw(credited, { nowMs: NOW + 31_000 })).toBe(25);
    expect(mightEnforceKw(credited, { nowMs: NOW + 30_000 + CREDIT_CLOCK_MARGIN_MS + 1 })).toBe(20);
    const unknownCredit = entry('a', accepted(20), {
      credit: {
        limit: { state: 'unknown', mightKw: null },
        until: new Date(NOW + 1).toISOString(),
      },
    });
    expect(mightEnforceKw(unknownCredit, { nowMs: NOW })).toBeNull();
  });

  it('leaves a refused credit profile at what the station held before', () => {
    const sent = creditTransition(NO_CREDIT_LIMIT, { type: 'send', commandId: 'c', kw: 30 });
    expect(creditTransition(sent, { type: 'rejected', commandId: 'c' })).toEqual({
      state: 'lost',
      mightKw: 30,
    });
  });
});

describe('reservations', () => {
  const lost = { state: 'lost', mightKw: 30 } as const;

  it('reserves offline, lost, refused and unknown stations (with or without an entry), never one awaiting', () => {
    const stations = [
      station('off', { isOnline: false, maxPowerKw: 22 }),
      station('lost'),
      station('refused', { maxPowerKw: 11, currentDrawKw: 14 }),
      station('unknown'),
      station('waiting'),
      station('fresh'),
    ];
    const previous = [
      entry('off', accepted(7)),
      entry('lost', lost),
      entry('refused', { state: 'refused', mightKw: null }),
      entry('unknown', { state: 'unknown', mightKw: null }),
      entry('waiting', limitTransition(accepted(5), { type: 'send', commandId: 'x', kw: 9 })),
    ];
    const reserved = limitReservations(stations, previous, { nowMs: NOW });
    expect([...reserved]).toEqual([
      ['off', 7],
      ['lost', 30],
      ['refused', 14],
      ['unknown', 50],
      ['fresh', 50],
    ]);
    expect(retryStationIds(stations, previous, NOW)).toEqual([
      'lost',
      'refused',
      'unknown',
      'fresh',
    ]);
  });

  it('does not reserve a station without an entry that holds a stored profile (Profiled)', () => {
    const stations = [station('a')];
    const stored = new Map([['a', { limit: profiledLimit(16) }]]);
    expect([...limitReservations(stations, null, { nowMs: NOW, storedLimits: stored })]).toEqual(
      [],
    );
    expect(retryStationIds(stations, null, NOW, stored)).toEqual([]);
  });

  it('counts an unrated station (no maximum) at its circuit capacity, unknown or refused (review 2)', () => {
    const unrated = { maxPowerKw: 0, circuitCapacityKw: 34.5 };
    const stations = [
      station('unknown', unrated),
      station('refused', unrated),
      station('none', unrated),
      station('off', { ...unrated, isOnline: false }),
    ];
    const previous = [
      entry('unknown', { state: 'unknown', mightKw: null }, { allocatedKw: 3 }),
      entry('refused', { state: 'refused', mightKw: null }, { allocatedKw: 3 }),
      entry('off', { state: 'unknown', mightKw: null }, { allocatedKw: 3 }),
    ];
    expect([...limitReservations(stations, previous, { nowMs: NOW })]).toEqual([
      ['unknown', 34.5],
      ['refused', 34.5],
      ['none', 34.5],
      ['off', 34.5],
    ]);
    // Never the allocation of the last cycle: it says nothing about what the station holds.
    expect(
      drawBoundKw(
        { maxPowerKw: 0, currentDrawKw: 0, circuitCapacityKw: 34.5 },
        entry('u', { state: 'unknown', mightKw: null }, { allocatedKw: 3 }),
        { nowMs: NOW },
      ),
    ).toBe(34.5);
  });

  it('reserves an offline station without an entry at its stored profile, else its maximum', () => {
    const offline = [station('a', { isOnline: false }), station('b', { isOnline: false })];
    const reserved = limitReservations(offline, null, {
      nowMs: NOW,
      storedLimits: new Map([['a', { limit: profiledLimit(16) }]]),
    });
    expect([...reserved]).toEqual([
      ['a', 16],
      ['b', 50],
    ]);
  });

  it('never reserves less than the draw', () => {
    expect(
      drawBoundKw({ maxPowerKw: 50, currentDrawKw: 12 }, entry('a', lost), { nowMs: NOW }),
    ).toBe(30);
    expect(
      drawBoundKw({ maxPowerKw: 50, currentDrawKw: 40 }, entry('a', lost), { nowMs: NOW }),
    ).toBe(40);
  });
});

describe('the send claims', () => {
  it('records the cuts on the locked state, which wins over the state read', () => {
    const read = [entry('a', accepted(20)), entry('b', accepted(10))];
    // A refusal stored after the cycle read the row.
    const locked = [
      entry('a', accepted(20)),
      entry(
        'b',
        { state: 'refused', commandId: 'r', sentKw: 10, mightKw: null },
        {
          rejectedUnits: ['W'],
        },
      ),
    ];
    const out = entriesForCuts(read, locked, [send('b', 8, 'cut-b')], new Set(), NOW);
    expect(out[0]?.limit).toEqual(accepted(20));
    expect(out[1]).toMatchObject({
      rejectedUnits: ['W'],
      limit: { state: 'awaiting', commandId: 'cut-b', sentKw: 8, mightKw: null },
    });
  });

  it('refuses a cut the locked state makes a raise, so nothing is written', () => {
    const read = [entry('a', { state: 'lost', mightKw: 30 })];
    const locked = [entry('a', accepted(10))];
    expect(() => entriesForCuts(read, locked, [send('a', 20, 'x')], new Set(), NOW)).toThrow(
      SendClassificationChanged,
    );
  });

  it('checks a station cut against the credit that may still hold, as the send classified it (I5)', () => {
    // The base holds 2 kW, a credit of 3 kW may still hold: a base of 3 kW
    // lowers nothing the station may enforce, so the claim keeps it a cut.
    const credit = { limit: accepted(3), until: new Date(NOW + 30_000).toISOString() };
    const read = [entry('a', accepted(2), { credit })];
    const out = entriesForCuts(read, read, [send('a', 3, 'base-a')], new Set(), NOW);
    expect(out[0]?.limit).toMatchObject({ state: 'awaiting', commandId: 'base-a', sentKw: 3 });
  });

  it('refuses a station cut above both the base and a credit that may still hold', () => {
    const credit = { limit: accepted(3), until: new Date(NOW + 30_000).toISOString() };
    const read = [entry('a', accepted(2), { credit })];
    expect(() => entriesForCuts(read, read, [send('a', 4, 'base-a')], new Set(), NOW)).toThrow(
      SendClassificationChanged,
    );
  });

  it('checks a cut by the kW the station enforces (review 4)', () => {
    // A station split per phase whose allocation fell but whose busiest phase
    // rose: it enforces 12 kW, above the 10 kW it holds, so it is no cut.
    expect(() =>
      entriesForCuts(
        [entry('a', accepted(10))],
        [entry('a', accepted(10))],
        [{ stationDbId: 'a', commandId: 'split', kw: 12, target: 'station' }],
        new Set(),
        NOW,
      ),
    ).toThrow(SendClassificationChanged);
  });

  it('holds the raises when another station might enforce more than the allocation counted (review 9)', () => {
    const counted = new Map([
      ['a', { countedKw: 10, reserved: false }],
      ['b', { countedKw: 20, reserved: false }],
    ]);
    const raise = [send('a', 16, 'raise')];
    // b rebooted between the claims: unknown, unlimited.
    expect(() =>
      entriesForRaises(
        [entry('a', accepted(10)), entry('b', { state: 'unknown', mightKw: null })],
        raise,
        new Set(),
        NOW,
        counted,
      ),
    ).toThrow(RaiseBasisChanged);
    // b refused a limit it was sent: reserved now, counted as a station in force.
    expect(() =>
      entriesForRaises(
        [entry('a', accepted(10)), entry('b', { state: 'refused', mightKw: 20 })],
        raise,
        new Set(),
        NOW,
        counted,
      ),
    ).toThrow(RaiseBasisChanged);
    // b accepted a lower limit: the raise goes out.
    expect(
      entriesForRaises(
        [entry('a', accepted(10)), entry('b', accepted(15))],
        raise,
        new Set(),
        NOW,
        counted,
      )[0]?.limit.state,
    ).toBe('awaiting');
  });

  it('holds a raise whose station has no entry in the locked row (review 3)', () => {
    expect(() => entriesForRaises(null, [send('a', 16, 'raise')], new Set(), NOW)).toThrow(
      RaiseBasisChanged,
    );
  });

  it('records the raises right before they go out and drops the released EVSE records', () => {
    const evse = {
      sessionId: 's1',
      transactionId: 't1',
      evseNumber: 1,
      kind: 'ac' as const,
      limitKw: 4,
      limitA: 6,
      phases: 3,
      rateUnit: 'A' as const,
      limit: accepted(4),
    };
    const locked = [entry('a', accepted(10), { evses: [evse] })];
    const out = entriesForRaises(locked, [send('a', 16, 'raise')], new Set(['a:t1']), NOW);
    expect(out[0]?.evses).toBeUndefined();
    expect(out[0]?.limit).toEqual({
      state: 'awaiting',
      commandId: 'raise',
      sentKw: 16,
      mightKw: 10,
    });
  });

  it('keeps the EVSE record of a transaction being released until its clear goes out', () => {
    const evse = {
      sessionId: 's1',
      transactionId: 't1',
      evseNumber: 1,
      kind: 'ac' as const,
      limitKw: 4,
      limitA: 6,
      phases: 3,
      rateUnit: 'A' as const,
      limit: accepted(4),
    };
    const out = entriesForCuts(
      [entry('a', accepted(10))],
      [entry('a', accepted(10), { evses: [evse] })],
      [],
      new Set(['a:t1']),
      NOW,
    );
    expect(out[0]?.evses?.map((e) => e.transactionId)).toEqual(['t1']);
  });

  it('moves an unanswered cut to lost at what the station may hold, an unpublished one at what it held', () => {
    const sent = (kw: number, id: string): LimitRecord =>
      limitTransition(accepted(30), { type: 'send', commandId: id, kw });
    const locked = [entry('a', sent(20, 'ca')), entry('b', sent(20, 'cb'))];
    const out = entriesAfterFailures(locked, [
      { stationDbId: 'a', commandId: 'ca', target: 'station', kind: 'timeout' },
      { stationDbId: 'b', commandId: 'cb', target: 'station', kind: 'unpublished' },
    ]);
    expect(out[0]?.limit).toMatchObject({ state: 'lost', mightKw: 30 });
    expect(out[1]?.limit).toMatchObject({ state: 'lost', mightKw: 30 });
    // A failure of another command changes nothing.
    const other = entriesAfterFailures(locked, [
      { stationDbId: 'a', commandId: 'older', target: 'station', kind: 'timeout' },
    ]);
    expect(other[0]?.limit.state).toBe('awaiting');
  });

  it('counts a credit profile sent and lost at what it may hold', () => {
    const until = new Date(NOW + 60_000).toISOString();
    const out = entriesForCuts(
      [entry('a', accepted(20), { credit: { limit: accepted(30), until } })],
      [entry('a', accepted(20), { credit: { limit: accepted(30), until } })],
      [{ stationDbId: 'a', commandId: 'cr', kw: 25, target: 'credit', validTo: until }],
      new Set(),
      NOW,
    );
    expect(out[0]?.credit?.limit).toEqual({
      state: 'awaiting',
      commandId: 'cr',
      sentKw: 25,
      mightKw: 30,
    });
    const lost = entriesAfterFailures(out, [
      { stationDbId: 'a', commandId: 'cr', target: 'credit', kind: 'timeout' },
    ]);
    expect(mightEnforceKw(lost[0], { nowMs: NOW })).toBe(30);
  });
});

describe('an operator save of the site config', () => {
  const held = [
    entry(
      'a',
      { state: 'lost', mightKw: 30 },
      {
        allocatedKw: 12,
        reserved: true,
        phaseWeights: { L1: 0.5, L2: 0.5, L3: 0 },
        credit: { limit: accepted(40), until: new Date(NOW + 60_000).toISOString() },
      },
    ),
  ];

  it('keeps every record and drops only the allocation', () => {
    const [kept] = entriesAfterConfigSave(held, { turnsOff: false }) ?? [];
    expect(kept).toEqual({
      stationId: 'A',
      stationDbId: 'a',
      allocatedKw: 0,
      limit: { state: 'lost', mightKw: 30 },
      credit: held[0]?.credit,
    });
    expect(mightEnforceKw(kept, { nowMs: NOW })).toBe(40);
  });

  it('makes every record unknown when the save turns load management off', () => {
    const [off] = entriesAfterConfigSave(held, { turnsOff: true }) ?? [];
    expect(off?.limit).toEqual({ state: 'unknown', mightKw: null });
    expect(off?.credit).toBeUndefined();
    expect(mightEnforceKw(off, { nowMs: NOW })).toBeNull();
    expect(entriesAfterConfigSave(null, { turnsOff: false })).toBeNull();
  });
});

describe('unit box defaults (TxDefaultProfile records)', () => {
  const value = {
    evseNumber: 2,
    unitId: 'u1',
    kind: 'ac' as const,
    limitA: 12.8,
    limitKw: 2.944,
    rateUnit: 'A' as const,
  };
  const send = (kw: number, commandId = 'd1'): LimitSendCommand => ({
    stationDbId: 'a',
    commandId,
    kw,
    target: 'evseDefault',
    evseNumber: 2,
  });

  it('records a default send, keeps a cut a cut, and refuses one the locked state makes a raise', () => {
    const cycle = entry('a', accepted(10), { evseDefaults: [{ ...value }] });
    const [first] = entriesForCuts([cycle], [cycle], [send(2.944)], new Set(), NOW);
    expect(evseDefaultMightKw(first?.evseDefaults?.[0] ?? value)).toBeNull();
    expect(first?.evseDefaults?.[0]?.limit?.state).toBe('awaiting');
    const held = entry('a', accepted(10), {
      evseDefaults: [{ ...value, limit: accepted(1, 'd0') }],
    });
    expect(() => entriesForCuts([cycle], [held], [send(2.944)], new Set(), NOW)).toThrow(
      SendClassificationChanged,
    );
  });

  it('keeps a default the send releases until its clear goes out, then drops it', () => {
    const locked = entry('a', accepted(10), {
      evseDefaults: [{ ...value, limit: accepted(2.944, 'd0') }],
    });
    const cycle = entry('a', accepted(10));
    const keys = new Set([defaultReleaseKey('a', 2)]);
    const [kept] = entriesForCuts([cycle], [locked], [], keys, NOW);
    expect(kept?.evseDefaults?.[0]?.evseNumber).toBe(2);
    const [dropped] = entriesForRaises([kept], [], keys, NOW);
    expect(dropped?.evseDefaults).toBeUndefined();
  });

  it('moves a default whose send timed out to lost at the higher of sent and held', () => {
    const locked = entry('a', accepted(10), {
      evseDefaults: [
        {
          ...value,
          limit: limitTransition(accepted(1, 'd0'), { type: 'send', commandId: 'd1', kw: 3 }),
        },
      ],
    });
    const [after] = entriesAfterFailures(
      [locked],
      [
        {
          stationDbId: 'a',
          commandId: 'd1',
          target: 'evseDefault',
          evseNumber: 2,
          kind: 'timeout',
        },
      ],
    );
    expect(after?.evseDefaults?.[0]?.limit).toMatchObject({ state: 'lost', mightKw: 3 });
  });

  it('makes every default unknown when a config save turns load management off', () => {
    const locked = entry('a', accepted(10), {
      evseDefaults: [{ ...value, limit: accepted(2.944, 'd0') }],
    });
    const [off] = entriesAfterConfigSave([locked], { turnsOff: true }) ?? [];
    expect(off?.evseDefaults?.[0]?.limit?.state).toBe('unknown');
    const [kept] = entriesAfterConfigSave([locked], { turnsOff: false }) ?? [];
    expect(kept?.evseDefaults?.[0]?.limit?.state).toBe('accepted');
  });

  it('holds the raises when a box default no longer holds its box at the second claim', () => {
    const locked = entry('a', accepted(10));
    const counted = new Map([['a', { countedKw: 10, reserved: false, boxesHold: () => false }]]);
    expect(() => entriesForRaises([locked], [], new Set(), NOW, counted)).toThrow(
      RaiseBasisChanged,
    );
  });
});

describe('stored profiles a first entry starts from (I4)', () => {
  it('counts a stored credit profile until its end plus the clock margin, then the base', () => {
    const until = new Date(NOW + 60_000).toISOString();
    const stored = { limit: profiledLimit(1), credit: { limit: profiledLimit(3), until } };
    expect(mightEnforceKw(undefined, { nowMs: NOW, storedLimit: stored })).toBe(3);
    expect(
      mightEnforceKw(undefined, {
        nowMs: NOW + 60_000 + CREDIT_CLOCK_MARGIN_MS + 1,
        storedLimit: stored,
      }),
    ).toBe(1);
  });

  it('reserves a station whose stored profiles hold no stack level 1 limit', () => {
    const until = new Date(NOW + 60_000).toISOString();
    const stored = new Map([
      [
        'a',
        {
          limit: { state: 'unknown' as const, mightKw: null },
          credit: { limit: profiledLimit(3), until },
        },
      ],
    ]);
    expect([
      ...limitReservations([station('a')], null, { nowMs: NOW, storedLimits: stored }).keys(),
    ]).toEqual(['a']);
  });
});

describe('a W limit counts in the unit it was held in (I1)', () => {
  it('stays a W limit while a cut in A is unanswered or lost, and not once the A limit is accepted', () => {
    const held = limitTransition(
      { state: 'awaiting', commandId: 'w', sentKw: 2, mightKw: null, sentInW: true },
      { type: 'accepted', commandId: 'w' },
    );
    expect(mightEnforceInWatts(entry('a', held), { nowMs: NOW })).toBe(true);
    const cut = limitTransition(held, { type: 'send', commandId: 'a1', kw: 0 });
    expect(mightEnforceInWatts(entry('a', cut), { nowMs: NOW })).toBe(true);
    const lost = limitTransition(cut, { type: 'timeout', commandId: 'a1' });
    expect(mightEnforceInWatts(entry('a', lost), { nowMs: NOW })).toBe(true);
    const done = limitTransition(cut, { type: 'accepted', commandId: 'a1' });
    expect(mightEnforceInWatts(entry('a', done), { nowMs: NOW })).toBe(false);
  });

  it('counts a stored W profile of a station without an entry as a W limit', () => {
    expect(
      mightEnforceInWatts(undefined, {
        nowMs: NOW,
        storedLimit: { limit: profiledLimit(2, true) },
      }),
    ).toBe(true);
    expect(
      mightEnforceInWatts(undefined, { nowMs: NOW, storedLimit: { limit: profiledLimit(2) } }),
    ).toBe(false);
  });
});

describe('a held raise (energy assets unknown)', () => {
  it('stores what the station may still enforce as its allocation, so the next cycle raises', () => {
    const locked = entry('a', accepted(0), { allocatedKw: 2.944, allocatedBaseKw: 2 });
    const [after] = entriesAfterFailures([locked], [], new Set(['a']), NOW);
    expect(after?.allocatedKw).toBe(0);
    expect(after?.allocatedBaseKw).toBeUndefined();
  });
});

describe('withExpiredConfirmationWaits', () => {
  const awaiting: LimitRecord = { state: 'awaiting', commandId: 'c-1', sentKw: 4, mightKw: 9 };

  it('moves every awaiting record to lost at the higher of sent and held once the wait has passed', () => {
    const [out] = withExpiredConfirmationWaits(
      [
        entry('a', awaiting, {
          credit: { limit: { ...awaiting, commandId: 'c-2' }, until: 'soon' },
          evses: [
            {
              transactionId: 'tx-1',
              evseNumber: 1,
              kw: 4,
              limit: { ...awaiting, commandId: 'c-3' },
            },
          ],
        } as unknown as Partial<AppliedAllocation>),
      ],
      true,
    );
    expect(out?.limit).toMatchObject({ state: 'lost', mightKw: 9 });
    expect(out?.credit?.limit).toMatchObject({ state: 'lost', mightKw: 9 });
    expect(out?.evses?.[0]?.limit).toMatchObject({ state: 'lost', mightKw: 9 });
  });

  it('keeps awaiting records while the wait still runs, and leaves other states alone', () => {
    const records = [entry('a', awaiting), entry('b', accepted(5))];
    expect(withExpiredConfirmationWaits(records, false)).toEqual(records);
    expect(withExpiredConfirmationWaits(records, true)[1]?.limit).toEqual(accepted(5));
  });

  it('reserves a station whose wait has passed, so it is retried (I5)', () => {
    const [expired] = withExpiredConfirmationWaits([entry('a', awaiting)], true);
    expect(retryStationIds([station('a')], [expired as AppliedAllocation], NOW)).toEqual(['a']);
    expect(retryStationIds([station('a')], [entry('a', awaiting)], NOW)).toEqual([]);
  });
});

describe('unknown credit profile (A2, I4)', () => {
  it('treats the credit profile of a station with an unknown limit as unknown', () => {
    expect(stationCredit(undefined, null)).toBe(UNKNOWN_CREDIT);
    expect(stationCredit(entry('a', accepted(4)))).toBeUndefined();
    // An entry records the credit itself: none after a boot means none may hold
    // (review M2), and an unknown one is carried in the entry.
    expect(stationCredit(entry('a', { state: 'unknown', mightKw: null }))).toBeUndefined();
    const carried = { ...entry('a', { state: 'unknown', mightKw: null }), credit: UNKNOWN_CREDIT };
    expect(stationCredit(carried)).toBe(UNKNOWN_CREDIT);
  });

  it('counts a station whose base was accepted while its credit replacement waits as unlimited', () => {
    const read = [{ ...entry('a', { state: 'unknown', mightKw: null }), credit: UNKNOWN_CREDIT }];
    const until = new Date(NOW + 660_000).toISOString();
    const [sent] = entriesForCuts(
      read,
      [],
      [
        { stationDbId: 'a', commandId: 'credit-a', kw: 0, target: 'credit', validTo: until },
        send('a', 0, 'base-a'),
      ],
      new Set(),
      NOW,
    );
    expect(sent?.credit).toMatchObject({ until, limit: { state: 'awaiting', mightKw: null } });
    // The base is accepted first: the old credit profile may still hold.
    const baseAccepted = { ...sent, limit: accepted(0, 'base-a') } as AppliedAllocation;
    expect(mightEnforceKw(baseAccepted, { nowMs: NOW })).toBeNull();
    // Once the replacement is accepted, only the new limit counts.
    const both = {
      ...baseAccepted,
      credit: { until, limit: accepted(0, 'credit-a') },
    } as AppliedAllocation;
    expect(mightEnforceKw(both, { nowMs: NOW })).toBe(0);
  });
  it('reserves a station whose base is in force while a credit that may hold is not (A5, I1)', () => {
    const until = new Date(NOW + 1_000).toISOString();
    const withCredit = (credit: LimitRecord, end = until): AppliedAllocation => ({
      ...entry('a', accepted(2)),
      credit: { until: end, limit: credit },
    });
    const unknown: LimitRecord = { state: 'unknown', mightKw: null };
    const fromUnknown: LimitRecord = {
      state: 'awaiting',
      commandId: 'c',
      sentKw: 5.888,
      mightKw: null,
    };
    const lost: LimitRecord = { state: 'lost', commandId: 'c', sentKw: 1, mightKw: 3 };
    for (const credit of [unknown, fromUnknown, lost]) {
      expect(retryStationIds([station('a')], [withCredit(credit)], NOW)).toEqual(['a']);
    }
    expect(retryStationIds([station('a')], [withCredit(accepted(3))], NOW)).toEqual([]);
    // Past its end and the clock margin, a credit profile holds nowhere.
    const ended = new Date(NOW - CREDIT_CLOCK_MARGIN_MS - 1).toISOString();
    expect(retryStationIds([station('a')], [withCredit(lost, ended)], NOW)).toEqual([]);
  });
});

describe('credit reading lifetime floor (review M4)', () => {
  it('is the clock margin plus one cycle, so the CSMS warns at the lifetime the cycle gives no credit for', () => {
    expect(ENERGY_ASSET_CREDIT_MIN_TTL_SECONDS * 1000).toBe(
      CREDIT_CLOCK_MARGIN_MS + LOAD_MANAGEMENT_CYCLE_MS,
    );
  });
});

describe('unknown credit replacement (review M2)', () => {
  const refusedFromUnknown: LimitRecord = { state: 'lost', mightKw: null };

  it('sends a first replacement that outlasts every credit profile, and keeps its end on a resend', () => {
    expect(creditReplacementEnd(UNKNOWN_CREDIT, NOW, LOAD_MANAGEMENT_CYCLE_MS)?.getTime()).toBe(
      NOW + UNKNOWN_CREDIT_REPLACEMENT_MS,
    );
    const end = new Date(NOW + 300_000).toISOString();
    const refused = { limit: refusedFromUnknown, until: end };
    // A refused replacement is sent again with its own end, never a later one.
    expect(
      creditReplacementEnd(refused, NOW + 60_000, LOAD_MANAGEMENT_CYCLE_MS)?.toISOString(),
    ).toBe(end);
    // Within a cycle of that end nothing is sent: the record ends by itself.
    expect(
      creditReplacementEnd(
        refused,
        Date.parse(end) - LOAD_MANAGEMENT_CYCLE_MS,
        LOAD_MANAGEMENT_CYCLE_MS,
      ),
    ).toBeNull();
    // A credit of a known bound needs no replacement.
    expect(
      creditReplacementEnd({ limit: accepted(5), until: end }, NOW, LOAD_MANAGEMENT_CYCLE_MS),
    ).toBeNull();
  });

  it('reserves a station with a refused replacement only until the replacement would have ended', () => {
    const end = new Date(NOW + 300_000).toISOString();
    const withRefused = entry('a', accepted(4), {
      credit: { limit: refusedFromUnknown, until: end },
    });
    expect(isLimitReserved(station('a'), withRefused, NOW)).toBe(true);
    const past = Date.parse(end) + CREDIT_CLOCK_MARGIN_MS + 1;
    expect(isLimitReserved(station('a'), withRefused, past)).toBe(false);
  });
});

describe('limitSettlesOnReplies (review C3)', () => {
  it('is true for no entry, an unknown and an awaiting limit, false for one that lasts', () => {
    const entry = (state: string) =>
      ({ stationId: 'S', stationDbId: 's', allocatedKw: 1, limit: { state } }) as never;
    expect(limitSettlesOnReplies(undefined)).toBe(true);
    expect(limitSettlesOnReplies(entry('unknown'))).toBe(true);
    expect(limitSettlesOnReplies(entry('awaiting'))).toBe(true);
    for (const state of ['accepted', 'refused', 'lost'])
      expect(limitSettlesOnReplies(entry(state))).toBe(false);
  });
});
