// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendOcppCommandAndWaitMock } = vi.hoisted(() => ({
  sendOcppCommandAndWaitMock: vi.fn(),
}));

vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: sendOcppCommandAndWaitMock,
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'values', 'onConflictDoUpdate', 'onConflictDoNothing'])
    chain[m] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(undefined));
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(undefined).then(res);
  return {
    db: { update: vi.fn(() => chain), insert: vi.fn(() => chain) },
    chargingProfilePushes: { id: 'id' },
    chargingProfilePushStations: { pushId: 'pushId', stationId: 'stationId' },
    chargingProfiles: {},
  };
});

import {
  processChargingProfilePush,
  processChargingProfileClear,
} from '../lib/charging-profile-push.js';

const template = {
  profileId: 101,
  profilePurpose: 'TxDefaultProfile',
  profileKind: 'Absolute',
  recurrencyKind: null,
  stackLevel: 0,
  evseId: 1,
  chargingRateUnit: 'W',
  schedulePeriods: [{ startPeriod: 0, limit: 11000 }],
  startSchedule: null,
  duration: null,
  validFrom: null,
  validTo: null,
};
const stations = [{ id: 'sta_1', stationId: 'CS-16' }];

beforeEach(() => {
  sendOcppCommandAndWaitMock.mockResolvedValue({ response: { status: 'Accepted' } });
});

// The payloads are OCPP 2.1 shaped. Passing a version would make the OCPP
// server send them unchanged, so a 1.6 station got 2.1 commands.
describe('charging profile push to an OCPP 1.6 station', () => {
  it('sends Clear and Set without a version so the OCPP server translates them', async () => {
    await processChargingProfilePush('cpp_1', stations, template, '1.6');

    const actions = sendOcppCommandAndWaitMock.mock.calls.map((c) => c[1] as string);
    expect(actions).toEqual(['ClearChargingProfile', 'SetChargingProfile']);
    for (const call of sendOcppCommandAndWaitMock.mock.calls) {
      expect(call).toHaveLength(3);
    }
  });

  it('sends a template clear without a version', async () => {
    await processChargingProfileClear(
      'cpp_2',
      stations,
      { profilePurpose: 'TxDefaultProfile', stackLevel: 0, evseId: 1 },
      '1.6',
    );

    expect(sendOcppCommandAndWaitMock.mock.calls[0]?.[1]).toBe('ClearChargingProfile');
    expect(sendOcppCommandAndWaitMock.mock.calls[0]).toHaveLength(3);
  });
});
