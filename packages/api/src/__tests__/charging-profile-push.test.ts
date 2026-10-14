// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendOcppCommandAndWaitMock, updateSetMock, whereMock } = vi.hoisted(() => ({
  sendOcppCommandAndWaitMock: vi.fn(),
  updateSetMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('../lib/charging-profile-id.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/charging-profile-id.js')>(
    '../lib/charging-profile-id.js',
  );
  return {
    ...actual,
    maxExternalConstraintsIds: vi.fn(async () => new Map<string, number>()),
    maxExternalConstraintsIdByIdentity: vi.fn(async () => null),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  and: (...conds: unknown[]) => ({ and: conds }),
}));

vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: sendOcppCommandAndWaitMock,
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'onConflictDoUpdate', 'onConflictDoNothing'])
    chain[m] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    updateSetMock(v);
    return chain;
  });
  chain['where'] = vi.fn((w: unknown) => {
    whereMock(w);
    return Promise.resolve(undefined);
  });
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(undefined).then(res);
  return {
    db: { update: vi.fn(() => chain), insert: vi.fn(() => chain) },
    chargingProfilePushes: { id: 'id', status: 'pushStatus' },
    chargingProfilePushStations: { pushId: 'pushId', stationId: 'stationId', status: 'status' },
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
  vi.clearAllMocks();
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

describe('LocalGeneration templates (K10.FR.06)', () => {
  it('never sends a clear for a LocalGeneration template', async () => {
    const localGeneration = { ...template, profilePurpose: 'LocalGeneration' };
    await processChargingProfilePush('cpp_5', stations, localGeneration, '2.1');
    const actions = sendOcppCommandAndWaitMock.mock.calls.map((c) => c[1] as string);
    expect(actions).not.toContain('ClearChargingProfile');
    expect(actions).toContain('SetChargingProfile');

    sendOcppCommandAndWaitMock.mockClear();
    await processChargingProfileClear(
      'cpp_6',
      stations,
      { profilePurpose: 'LocalGeneration', stackLevel: 0, evseId: 0 },
      '2.1',
    );
    expect(sendOcppCommandAndWaitMock).not.toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });
});

describe('terminal push states (P5)', () => {
  it('writes a station result only while it is pending and completes only an active push', async () => {
    await processChargingProfilePush('cpp_8', stations, template, '1.6');
    const wheres = whereMock.mock.calls.map((c) => JSON.stringify(c[0]));
    const stationWrite = wheres.find((w) => w.includes('stationId'));
    expect(stationWrite).toContain('["status","pending"]');
    const pushWrite = wheres.find((w) => !w.includes('stationId'));
    expect(pushWrite).toContain('["pushStatus","active"]');
  });
});
