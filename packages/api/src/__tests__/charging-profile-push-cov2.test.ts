// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, setCalls, deleteCalls, state } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  setCalls: [] as { table: string; values: Record<string, unknown> }[],
  deleteCalls: [] as string[],
  state: { failPushUpdate: 0, failStationUpdate: false },
}));

vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: sendMock,
}));

vi.mock('@evtivity/database', () => {
  const pushes = { __name: 'pushes', id: 'id' };
  const pushStations = { __name: 'pushStations', pushId: 'pushId', stationId: 'stationId' };
  const profiles = { __name: 'profiles', stationId: 'stationId', evseId: 'evseId' };
  return {
    db: {
      update: vi.fn((table: { __name: string }) => ({
        set: (values: Record<string, unknown>) => {
          setCalls.push({ table: table.__name, values });
          return {
            where: () => {
              if (table.__name === 'pushes' && state.failPushUpdate > 0) {
                state.failPushUpdate -= 1;
                return Promise.reject(new Error('db down'));
              }
              if (table.__name === 'pushStations' && state.failStationUpdate) {
                return Promise.reject(new Error('db down'));
              }
              return Promise.resolve(undefined);
            },
          };
        },
      })),
      delete: vi.fn((table: { __name: string }) => ({
        where: () => {
          deleteCalls.push(table.__name);
          return Promise.resolve(undefined);
        },
      })),
    },
    chargingProfilePushes: pushes,
    chargingProfilePushStations: pushStations,
    chargingProfiles: profiles,
  };
});

import {
  processChargingProfilePush,
  processChargingProfileClear,
} from '../lib/charging-profile-push.js';

const template = {
  profileId: 7,
  profilePurpose: 'TxDefaultProfile',
  profileKind: 'Recurring',
  recurrencyKind: 'Daily',
  stackLevel: 2,
  evseId: 1,
  chargingRateUnit: 'A',
  schedulePeriods: [{ startPeriod: 0, limit: 16 }],
  startSchedule: new Date('2026-01-01T00:00:00.000Z'),
  duration: 3600,
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validTo: new Date('2026-12-31T00:00:00.000Z'),
};
const stations = [{ id: 'sta_1', stationId: 'CS-1' }];
const target = { profilePurpose: 'TxDefaultProfile', stackLevel: 2, evseId: 1 };

function stationSets(): Record<string, unknown>[] {
  return setCalls.filter((c) => c.table === 'pushStations').map((c) => c.values);
}
function pushSets(): Record<string, unknown>[] {
  return setCalls.filter((c) => c.table === 'pushes').map((c) => c.values);
}

beforeEach(() => {
  setCalls.length = 0;
  deleteCalls.length = 0;
  state.failPushUpdate = 0;
  state.failStationUpdate = false;
  sendMock.mockReset();
});

describe('processChargingProfilePush', () => {
  it('builds the full SetChargingProfile payload from the template', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Accepted' } });
    await processChargingProfilePush('cpp_1', stations, template, '1.6');

    const setCall = sendMock.mock.calls.find((c) => c[1] === 'SetChargingProfile');
    expect(setCall?.[2]).toEqual({
      evseId: 1,
      chargingProfile: {
        id: 7,
        stackLevel: 2,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Recurring',
        recurrencyKind: 'Daily',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-12-31T00:00:00.000Z',
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'A',
            startSchedule: '2026-01-01T00:00:00.000Z',
            duration: 3600,
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
          },
        ],
      },
    });
    expect(stationSets()[0]).toMatchObject({ status: 'accepted' });
    expect(pushSets()[0]).toMatchObject({ status: 'completed' });
    // 1.6 has no GetChargingProfiles refresh
    expect(sendMock.mock.calls.some((c) => c[1] === 'GetChargingProfiles')).toBe(false);
  });

  it('still sends Set when the best-effort Clear throws', async () => {
    sendMock.mockImplementation((_s: string, action: string) => {
      if (action === 'ClearChargingProfile') return Promise.reject(new Error('timeout'));
      return Promise.resolve({ response: { status: 'Accepted' } });
    });
    await processChargingProfilePush('cpp_1', stations, template, '1.6');
    expect(stationSets()[0]).toMatchObject({ status: 'accepted' });
  });

  it('marks the station failed with the command error', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      Promise.resolve(
        action === 'SetChargingProfile' ? { error: 'Station offline' } : { response: {} },
      ),
    );
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'failed', errorInfo: 'Station offline' });
    expect(pushSets()[0]).toMatchObject({ status: 'completed' });
  });

  it('refreshes station profiles on 2.1 after an accepted set and ignores refresh failure', async () => {
    sendMock.mockImplementation((_s: string, action: string) => {
      if (action === 'GetChargingProfiles') return Promise.reject(new Error('gone'));
      return Promise.resolve({ response: { status: 'Accepted' } });
    });
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    const get = sendMock.mock.calls.find((c) => c[1] === 'GetChargingProfiles');
    expect(get?.[0]).toBe('CS-1');
    expect(get?.[3]).toBe('ocpp2.1');
    expect((get?.[2] as { chargingProfile: unknown }).chargingProfile).toEqual({});
    expect(stationSets()[0]).toMatchObject({ status: 'accepted' });
  });

  it('records reasonCode and additionalInfo on rejection', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      Promise.resolve(
        action === 'SetChargingProfile'
          ? {
              response: {
                status: 'Rejected',
                statusInfo: { reasonCode: 'InvalidSchedule', additionalInfo: 'limit too high' },
              },
            }
          : { response: {} },
      ),
    );
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    expect(stationSets()[0]).toMatchObject({
      status: 'rejected',
      errorInfo: 'InvalidSchedule: limit too high',
    });
  });

  it('records the bare reasonCode when additionalInfo is empty', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      Promise.resolve(
        action === 'SetChargingProfile'
          ? {
              response: {
                status: 'Rejected',
                statusInfo: { reasonCode: 'NoEVSE', additionalInfo: '' },
              },
            }
          : { response: {} },
      ),
    );
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'rejected', errorInfo: 'NoEVSE' });
  });

  it('falls back to the status, then Unknown, when no reasonCode exists', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      Promise.resolve(
        action === 'SetChargingProfile' ? { response: { status: 'Rejected' } } : { response: {} },
      ),
    );
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'rejected', errorInfo: 'Rejected' });

    setCalls.length = 0;
    sendMock.mockImplementation(() => Promise.resolve({ response: undefined }));
    await processChargingProfilePush('cpp_1', stations, template, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'rejected', errorInfo: 'Unknown' });
  });

  it('marks the station failed with Internal error when the set throws', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      action === 'SetChargingProfile'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ response: {} }),
    );
    await processChargingProfilePush('cpp_1', stations, template, '1.6');
    expect(stationSets()[0]).toMatchObject({ status: 'failed', errorInfo: 'Internal error' });
  });

  it('retries marking the push completed when the batch fails', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Accepted' } });
    state.failStationUpdate = true;
    // station update and its catch-path update both reject -> batch-level catch
    await expect(
      processChargingProfilePush('cpp_1', stations, template, '1.6'),
    ).resolves.toBeUndefined();
    expect(pushSets()).toEqual([expect.objectContaining({ status: 'completed' })]);
  });

  it('swallows a failure of the final completed update in the batch-level catch', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Accepted' } });
    state.failPushUpdate = 2;
    await expect(
      processChargingProfilePush('cpp_1', stations, template, '1.6'),
    ).resolves.toBeUndefined();
    expect(pushSets()).toHaveLength(2);
  });

  it('processes stations in batches of ten', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Accepted' } });
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `sta_${String(i)}`,
      stationId: `CS-${String(i)}`,
    }));
    await processChargingProfilePush('cpp_1', many, template, '1.6');
    const setTargets = sendMock.mock.calls
      .filter((c) => c[1] === 'SetChargingProfile')
      .map((c) => c[0] as string);
    expect(setTargets).toHaveLength(12);
    expect(new Set(setTargets).size).toBe(12);
  });
});

describe('processChargingProfileClear', () => {
  it('marks failed with the command error', async () => {
    sendMock.mockResolvedValue({ error: 'Not connected' });
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'failed', errorInfo: 'Not connected' });
    expect(deleteCalls).toEqual([]);
    expect(pushSets()[0]).toMatchObject({ status: 'completed' });
  });

  it('deletes mirrored profiles and refreshes on 2.1 when Accepted', async () => {
    sendMock.mockImplementation((_s: string, action: string) =>
      action === 'GetChargingProfiles'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve({ response: { status: 'Accepted' } }),
    );
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(deleteCalls).toEqual(['profiles']);
    expect(sendMock.mock.calls.some((c) => c[1] === 'GetChargingProfiles')).toBe(true);
    expect(stationSets()[0]).toMatchObject({ status: 'accepted' });
    expect(stationSets()[0]).not.toHaveProperty('errorInfo');
  });

  it('does not refresh on 1.6 after Accepted', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Accepted' } });
    await processChargingProfileClear('cpp_2', stations, target, '1.6');
    expect(deleteCalls).toEqual(['profiles']);
    expect(sendMock.mock.calls.map((c) => c[1])).toEqual(['ClearChargingProfile']);
  });

  it('treats Unknown as accepted with no_matching_profile', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Unknown' } });
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(stationSets()[0]).toMatchObject({
      status: 'accepted',
      errorInfo: 'no_matching_profile',
    });
    expect(deleteCalls).toEqual([]);
  });

  it('marks rejected with any other status', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Rejected' } });
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'rejected', errorInfo: 'Rejected' });
  });

  it('marks failed when the response has no status', async () => {
    sendMock.mockResolvedValue({ response: {} });
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(stationSets()[0]).toMatchObject({
      status: 'failed',
      errorInfo: 'No status in response',
    });
  });

  it('marks failed with Internal error when the command throws', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await processChargingProfileClear('cpp_2', stations, target, '2.1');
    expect(stationSets()[0]).toMatchObject({ status: 'failed', errorInfo: 'Internal error' });
  });

  it('still marks the push completed when the batch fails', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Rejected' } });
    state.failStationUpdate = true;
    state.failPushUpdate = 0;
    await expect(
      processChargingProfileClear('cpp_2', stations, target, '2.1'),
    ).resolves.toBeUndefined();
    expect(pushSets()).toEqual([expect.objectContaining({ status: 'completed' })]);
  });

  it('swallows a failure of the final completed update', async () => {
    sendMock.mockResolvedValue({ response: { status: 'Rejected' } });
    state.failPushUpdate = 2;
    await expect(
      processChargingProfileClear('cpp_2', stations, target, '2.1'),
    ).resolves.toBeUndefined();
    expect(pushSets()).toHaveLength(2);
  });
});
