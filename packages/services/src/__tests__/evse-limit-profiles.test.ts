// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import {
  appliedEvseLimit,
  buildEvseLimitProfile,
  evseLimitCommands,
  evseLimitRateUnit,
  evseLimitReleases,
  orderEvseLimitCommands,
  parseAppliedEvseLimits,
} from '../evse-limit-profiles.js';
import type { EvseLimitResult } from '../evse-limits.js';
import type { StationPowerInfo } from '../load-management.service.js';

const now = new Date('2026-11-24T10:00:00.400Z');

const acLimit = (over: Partial<EvseLimitResult> = {}): EvseLimitResult => ({
  sessionId: 'ses_1',
  transactionId: 'tx-1',
  evseNumber: 2,
  unitId: null,
  kind: 'ac',
  limitA: 6,
  limitKw: 4.14,
  phases: 3,
  reason: 'tariff_limit',
  paused: false,
  ...over,
});

const dcLimit: EvseLimitResult = {
  sessionId: 'ses_dc',
  transactionId: 'tx-dc',
  evseNumber: 1,
  unitId: null,
  kind: 'dc',
  limitA: null,
  limitKw: 48.25,
  phases: null,
  reason: 'station_share',
  paused: false,
};

function station(over: Partial<StationPowerInfo> = {}): StationPowerInfo {
  return {
    id: 'sta_1',
    stationId: 'CS-1',
    circuitId: 'cir_1',
    currentDrawKw: 0,
    phasePowerKw: null,
    maxPowerKw: 22,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    minPowerKw: 0,
    rateUnit: 'A',
    profileId: 1_000_000_000,
    sessions: [],
    ...over,
  };
}

type Period = { startPeriod: number; limit: number; numberPhases?: number };
type Profile = {
  evseId: number;
  chargingProfile: {
    id: number;
    stackLevel: number;
    chargingProfilePurpose: string;
    chargingProfileKind: string;
    transactionId: string;
    chargingSchedule: Array<{
      startSchedule: string;
      chargingRateUnit: string;
      chargingSchedulePeriod: Period[];
    }>;
  };
};

describe('buildEvseLimitProfile', () => {
  it('sends an AC limit in A as a TxProfile of the transaction on its EVSE', () => {
    const p = buildEvseLimitProfile('CS-1', acLimit({ limitA: 12.37 }), 'A', now) as Profile;
    expect(p.evseId).toBe(2);
    expect(p.chargingProfile).toMatchObject({
      id: chargingNeedsProfileId('CS-1', 'tx-1'),
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId: 'tx-1',
    });
    const schedule = p.chargingProfile.chargingSchedule[0];
    expect(schedule?.chargingRateUnit).toBe('A');
    expect(schedule?.startSchedule).toBe('2026-11-24T09:59:00.000Z');
    expect(schedule?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 12.3, numberPhases: 3 },
    ]);
  });

  it('sends an AC limit in W with numberPhases for a station that takes W only', () => {
    const p = buildEvseLimitProfile(
      'CS-1',
      acLimit({ limitA: 16, limitKw: 3.68, phases: 1 }),
      'W',
      now,
    ) as Profile;
    expect(p.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 3680, numberPhases: 1 },
    ]);
  });

  it('sends a DC limit in W without numberPhases', () => {
    const p = buildEvseLimitProfile('CS-1', dcLimit, 'W', now) as Profile;
    expect(p.chargingProfile.chargingSchedule[0]?.chargingRateUnit).toBe('W');
    expect(p.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 48250 },
    ]);
  });

  it('sends a paused AC EVSE 0 A', () => {
    const p = buildEvseLimitProfile(
      'CS-1',
      acLimit({ limitA: 0, limitKw: 0, paused: true }),
      'A',
      now,
    ) as Profile;
    expect(p.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit).toBe(0);
  });
});

describe('evseLimitRateUnit', () => {
  it('takes A for AC unless the station reports W only, and W for DC', () => {
    expect(evseLimitRateUnit({ supportedRateUnits: [] }, 'ac')).toBe('A');
    expect(evseLimitRateUnit({ supportedRateUnits: ['A', 'W'] }, 'ac')).toBe('A');
    expect(evseLimitRateUnit({ supportedRateUnits: ['W'] }, 'ac')).toBe('W');
    expect(evseLimitRateUnit({ supportedRateUnits: ['A'] }, 'dc')).toBe('W');
  });
});

describe('evseLimitCommands and their order', () => {
  it('compares each limit with the one its transaction holds and skips plan sessions', () => {
    const limits = new Map([
      [
        'sta_1',
        [
          acLimit(),
          acLimit({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 3, limitKw: 17.9 }),
          acLimit({ sessionId: 'ses_3', transactionId: 'tx-3', evseNumber: 4 }),
        ],
      ],
    ]);
    const previous = new Map([
      [
        'sta_1',
        [
          appliedEvseLimit(acLimit({ limitKw: 8 }), 'A'),
          appliedEvseLimit(
            acLimit({ sessionId: 'ses_2', transactionId: 'tx-2', limitKw: 10 }),
            'A',
          ),
        ],
      ],
    ]);
    const commands = evseLimitCommands(
      limits,
      new Map([['sta_1', station({ supportedRateUnits: ['W'] })]]),
      previous,
      new Set(['ses_3']),
    );
    expect(commands.map((c) => [c.limit.transactionId, c.previousKw, c.rateUnit])).toEqual([
      ['tx-1', 8, 'W'],
      ['tx-2', 10, 'W'],
    ]);
    const { cuts, raises } = orderEvseLimitCommands(commands);
    expect(cuts.map((c) => c.limit.transactionId)).toEqual(['tx-1']);
    expect(raises.map((c) => c.limit.transactionId)).toEqual(['tx-2']);
  });

  it('treats a new limit as a cut', () => {
    const commands = evseLimitCommands(
      new Map([['sta_1', [acLimit()]]]),
      new Map([['sta_1', station()]]),
      new Map(),
    );
    expect(orderEvseLimitCommands(commands).cuts).toHaveLength(1);
  });
});

describe('evseLimitReleases', () => {
  const sessions = [
    {
      sessionId: 'ses_1',
      transactionId: 'tx-1',
      evseDbId: 'evs_1',
      evseNumber: 2,
      unitId: null,
      kind: 'ac' as const,
      ratingKw: 22,
      ratingA: 32,
      tariffId: null,
      tariffMaxCurrentA: null,
      phases: null,
      startedAt: now,
    },
  ];

  it('clears the TxProfile of a charging session that no longer gets an EVSE limit', () => {
    const previous = new Map([['sta_1', [appliedEvseLimit(acLimit(), 'A')]]]);
    const stations = new Map([['sta_1', station({ sessions })]]);
    expect(evseLimitReleases(previous, [], stations)).toEqual([
      { stationId: 'CS-1', transactionId: 'tx-1' },
    ]);
  });

  it('leaves ended sessions, plan sessions, offline stations and sessions still limited', () => {
    const previous = new Map([['sta_1', [appliedEvseLimit(acLimit(), 'A')]]]);
    expect(evseLimitReleases(previous, [], new Map([['sta_1', station()]]))).toEqual([]);
    expect(
      evseLimitReleases(
        previous,
        [],
        new Map([['sta_1', station({ sessions })]]),
        new Set(['ses_1']),
      ),
    ).toEqual([]);
    expect(
      evseLimitReleases(previous, [], new Map([['sta_1', station({ sessions, isOnline: false })]])),
    ).toEqual([]);
    const commands = evseLimitCommands(
      new Map([['sta_1', [acLimit()]]]),
      new Map([['sta_1', station()]]),
      new Map(),
    );
    expect(
      evseLimitReleases(previous, commands, new Map([['sta_1', station({ sessions })]])),
    ).toEqual([]);
  });
});

describe('parseAppliedEvseLimits', () => {
  it('reads stored limits and drops malformed rows', () => {
    const stored = [appliedEvseLimit(acLimit(), 'A'), { transactionId: 'x' }, null];
    expect(parseAppliedEvseLimits(JSON.parse(JSON.stringify(stored)))).toEqual([
      appliedEvseLimit(acLimit(), 'A'),
    ]);
    expect(parseAppliedEvseLimits('nope')).toEqual([]);
  });
});
