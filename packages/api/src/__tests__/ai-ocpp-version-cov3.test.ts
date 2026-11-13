// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  knownOcppProtocol,
  mapOcppCommand,
  ocppToolDescription,
  ocppVersionLabel,
  translatedOperationIds,
} from '../services/ai/tools/ocpp-version.js';
import type { OcppCommandMapping } from '../services/ai/tools/ocpp-version.js';

function tool(operationId: string): { name: string; operationId: string; pathTemplate: string } {
  const [, version, action] = /^ocppv(16|21)_(.+)$/.exec(operationId) ?? [];
  return {
    name: operationId,
    operationId,
    pathTemplate: `/v1/ocpp/commands/v${version ?? '21'}/${action ?? operationId}`,
  };
}

/** Maps a 1.6 tool to a 2.1 station. */
function to21(op: string, args: Record<string, unknown>): OcppCommandMapping {
  return mapOcppCommand(tool(op), { stationId: 'CS-1', ...args }, 'ocpp2.1', {
    remoteStartId: () => 77,
  });
}

/** Maps a 2.1 tool to a 1.6 station. */
function to16(op: string, args: Record<string, unknown>): OcppCommandMapping {
  return mapOcppCommand(tool(op), { stationId: 'CS-1', ...args }, 'ocpp1.6');
}

function mappedArgs(m: OcppCommandMapping): Record<string, unknown> {
  if (m.kind !== 'mapped') throw new Error(`not mapped: ${JSON.stringify(m)}`);
  return m.args;
}

function reason(m: OcppCommandMapping): string {
  if (m.kind !== 'unsupported') throw new Error(`not unsupported: ${JSON.stringify(m)}`);
  return m.message;
}

const SCHEDULE_16 = {
  chargingRateUnit: 'A',
  duration: 60,
  chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
};
const PROFILE_16 = {
  chargingProfileId: 5,
  transactionId: 12,
  stackLevel: 1,
  chargingProfilePurpose: 'TxProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: SCHEDULE_16,
};
const PROFILE_21 = {
  id: 5,
  transactionId: '12',
  stackLevel: 1,
  chargingProfilePurpose: 'ChargingStationMaxProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [{ id: 5, chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 7000 }] }],
};

describe('labels and descriptions', () => {
  it('labels each protocol and knows only stored protocols', () => {
    expect(ocppVersionLabel('ocpp1.6')).toBe('OCPP 1.6');
    expect(ocppVersionLabel('ocpp2.0.1')).toBe('OCPP 2.0.1');
    expect(ocppVersionLabel('ocpp2.1')).toBe('OCPP 2.1');
    expect(knownOcppProtocol('ocpp2.0.1')).toBe('ocpp2.0.1');
    expect(knownOcppProtocol('ocpp9')).toBeNull();
    expect(knownOcppProtocol(null)).toBeNull();
  });

  it('adds the version rule only to command tools', () => {
    expect(ocppToolDescription({ description: 'List', pathTemplate: '/v1/stations' })).toBe('List');
    expect(
      ocppToolDescription({ description: 'Reset', pathTemplate: '/v1/ocpp/commands/v16/Reset' }),
    ).toContain('For OCPP 1.6 stations');
  });

  it('lists the translated tools of both directions', () => {
    const ids = translatedOperationIds();
    expect(ids).toContain('ocppv16_Reset');
    expect(ids).toContain('ocppv21_SendLocalList');
  });

  it('matches a non-command tool and a tool of the station version', () => {
    expect(
      mapOcppCommand({ name: 'x', operationId: 'x', pathTemplate: '/v1/sites' }, {}, 'ocpp1.6'),
    ).toEqual({ kind: 'match' });
    expect(mapOcppCommand(tool('ocppv21_Reset'), {}, 'ocpp2.0.1')).toEqual({ kind: 'match' });
  });

  it('refuses an untranslated tool of the other version', () => {
    expect(reason(to21('ocppv16_DataTransfer', {}))).toContain('has no OCPP 2.1 equivalent');
  });
});

describe('1.6 tools on a 2.1 station', () => {
  it('translates Reset and refuses an unknown type', () => {
    expect(to21('ocppv16_Reset', { type: 'Soft' })).toEqual({
      kind: 'mapped',
      operationId: 'ocppv21_Reset',
      args: { stationId: 'CS-1', type: 'OnIdle' },
    });
    expect(reason(to21('ocppv16_Reset', { type: 'Warm' }))).toContain(
      'the reset type has no equivalent',
    );
  });

  it('translates ChangeAvailability and UnlockConnector', () => {
    expect(
      mappedArgs(to21('ocppv16_ChangeAvailability', { type: 'Inoperative', connectorId: 2 })),
    ).toEqual({ stationId: 'CS-1', operationalStatus: 'Inoperative', evse: { id: 2 } });
    expect(
      mappedArgs(to21('ocppv16_ChangeAvailability', { type: 'Operative', connectorId: 0 })),
    ).toEqual({ stationId: 'CS-1', operationalStatus: 'Operative' });
    expect(mappedArgs(to21('ocppv16_UnlockConnector', { connectorId: 3 }))).toEqual({
      stationId: 'CS-1',
      evseId: 3,
      connectorId: 1,
    });
  });

  it('translates a remote start with a profile', () => {
    expect(
      mappedArgs(
        to21('ocppv16_RemoteStartTransaction', {
          idTag: 'TAG',
          connectorId: 1,
          chargingProfile: PROFILE_16,
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      remoteStartId: 77,
      idToken: { idToken: 'TAG', type: 'Central' },
      evseId: 1,
      chargingProfile: {
        id: 5,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        transactionId: '12',
        chargingSchedule: [
          {
            id: 5,
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
            duration: 60,
          },
        ],
      },
    });
  });

  it('uses a random remote start id by default', () => {
    const m = mapOcppCommand(
      tool('ocppv16_RemoteStartTransaction'),
      { stationId: 'CS-1', idTag: 'T' },
      'ocpp2.1',
    );
    const id = mappedArgs(m)['remoteStartId'];
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('refuses a remote start whose profile cannot be translated', () => {
    const cases: [unknown, string][] = [
      ['x', 'the charging profile is missing'],
      [{ ...PROFILE_16, extra: 1 }, 'the charging profile field extra has no equivalent'],
      [{ ...PROFILE_16, chargingSchedule: 5 }, 'the charging profile has no schedule'],
      [
        { ...PROFILE_16, chargingSchedule: { ...SCHEDULE_16, foo: 1 } },
        'the charging schedule field foo has no equivalent',
      ],
      [{ ...PROFILE_16, chargingProfilePurpose: 'Other' }, 'the charging profile purpose'],
      [
        { ...PROFILE_16, chargingSchedule: { chargingRateUnit: 'A' } },
        'the charging schedule has no periods',
      ],
      [
        { ...PROFILE_16, chargingSchedule: { ...SCHEDULE_16, chargingSchedulePeriod: [1] } },
        'a charging schedule period is not an object',
      ],
      [
        {
          ...PROFILE_16,
          chargingSchedule: { ...SCHEDULE_16, chargingSchedulePeriod: [{ limit: 1, x: 2 }] },
        },
        'the schedule period field x has no equivalent',
      ],
      [
        {
          ...PROFILE_16,
          chargingSchedule: { ...SCHEDULE_16, chargingSchedulePeriod: [{ startPeriod: 0 }] },
        },
        'a schedule period has no limit',
      ],
    ];
    for (const [profile, text] of cases) {
      expect(
        reason(to21('ocppv16_RemoteStartTransaction', { idTag: 'T', chargingProfile: profile })),
      ).toContain(text);
    }
  });

  it('translates stop, the plain tools, triggers and composite schedules', () => {
    expect(mappedArgs(to21('ocppv16_RemoteStopTransaction', { transactionId: 9 }))).toEqual({
      stationId: 'CS-1',
      transactionId: '9',
    });
    expect(to21('ocppv16_ClearCache', {})).toEqual({
      kind: 'mapped',
      operationId: 'ocppv21_ClearCache',
      args: { stationId: 'CS-1' },
    });
    expect(
      to21('ocppv16_ExtendedTriggerMessage', {
        requestedMessage: 'SignChargePointCertificate',
      }),
    ).toEqual({
      kind: 'mapped',
      operationId: 'ocppv21_TriggerMessage',
      args: { stationId: 'CS-1', requestedMessage: 'SignChargingStationCertificate' },
    });
    expect(
      mappedArgs(
        to21('ocppv16_TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 2 }),
      ),
    ).toEqual({ stationId: 'CS-1', requestedMessage: 'MeterValues', evse: { id: 2 } });
    expect(
      reason(to21('ocppv16_TriggerMessage', { requestedMessage: 'DiagnosticsStatus' })),
    ).toContain('the DiagnosticsStatus trigger has no equivalent');
    expect(
      mappedArgs(to21('ocppv16_GetCompositeSchedule', { duration: 60, connectorId: 1 })),
    ).toEqual({ stationId: 'CS-1', duration: 60, evseId: 1 });
  });

  it('translates ClearChargingProfile with and without criteria', () => {
    expect(
      mappedArgs(
        to21('ocppv16_ClearChargingProfile', {
          id: 3,
          connectorId: 1,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          stackLevel: 2,
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      chargingProfileId: 3,
      chargingProfileCriteria: {
        evseId: 1,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        stackLevel: 2,
      },
    });
    expect(mappedArgs(to21('ocppv16_ClearChargingProfile', { id: 3 }))).toEqual({
      stationId: 'CS-1',
      chargingProfileId: 3,
    });
    expect(
      reason(to21('ocppv16_ClearChargingProfile', { chargingProfilePurpose: 'Nope' })),
    ).toContain('the profile purpose has no equivalent');
  });

  it('translates SetChargingProfile and refuses a bad profile', () => {
    expect(
      mappedArgs(
        to21('ocppv16_SetChargingProfile', { connectorId: 1, csChargingProfiles: PROFILE_16 }),
      )['evseId'],
    ).toBe(1);
    expect(reason(to21('ocppv16_SetChargingProfile', { csChargingProfiles: null }))).toContain(
      'the charging profile is missing',
    );
  });

  it('translates ReserveNow with and without a parent tag', () => {
    expect(
      mappedArgs(
        to21('ocppv16_ReserveNow', {
          reservationId: 4,
          expiryDate: '2026-01-01T00:00:00Z',
          idTag: 'T',
          parentIdTag: 'P',
          connectorId: 0,
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      id: 4,
      expiryDateTime: '2026-01-01T00:00:00Z',
      idToken: { idToken: 'T', type: 'Central' },
      groupIdToken: { idToken: 'P', type: 'Central' },
    });
    expect(mappedArgs(to21('ocppv16_ReserveNow', { idTag: 'T', connectorId: 2 }))).toMatchObject({
      evseId: 2,
    });
  });

  it('refuses SendLocalList and GetConfiguration with guidance', () => {
    expect(reason(to21('ocppv16_SendLocalList', {}))).toContain('ocppv21_send_local_list');
    expect(reason(to21('ocppv16_GetConfiguration', {}))).toContain('ocppv21_get_variables');
  });

  it('names the station in the refusal for a 2.0.1 station', () => {
    expect(
      reason(mapOcppCommand(tool('ocppv16_Reset'), { stationId: 'CS-1', type: 'X' }, 'ocpp2.0.1')),
    ).toContain('Station CS-1 uses OCPP 2.0.1');
  });
});

describe('2.1 tools on a 1.6 station', () => {
  it('translates Reset and refuses an EVSE reset or an unknown type', () => {
    expect(mappedArgs(to16('ocppv21_Reset', { type: 'Immediate' }))).toEqual({
      stationId: 'CS-1',
      type: 'Hard',
    });
    expect(reason(to16('ocppv21_Reset', { type: 'OnIdle', evseId: 1 }))).toContain(
      'whole station only',
    );
    expect(reason(to16('ocppv21_Reset', { type: 'Later' }))).toContain(
      'the Later reset type has no equivalent',
    );
  });

  it('translates ChangeAvailability for the station and an EVSE', () => {
    expect(
      mappedArgs(to16('ocppv21_ChangeAvailability', { operationalStatus: 'Operative' })),
    ).toEqual({ stationId: 'CS-1', connectorId: 0, type: 'Operative' });
    expect(
      mappedArgs(
        to16('ocppv21_ChangeAvailability', {
          operationalStatus: 'Inoperative',
          evse: { id: 2, connectorId: 1 },
        }),
      ),
    ).toEqual({ stationId: 'CS-1', connectorId: 2, type: 'Inoperative' });
    expect(
      reason(
        to16('ocppv21_ChangeAvailability', {
          operationalStatus: 'X',
          evse: { id: 2, connectorId: 2 },
        }),
      ),
    ).toContain('by its EVSE number only');
  });

  it('translates UnlockConnector for connector 1 or the EVSE number', () => {
    expect(mappedArgs(to16('ocppv21_UnlockConnector', { evseId: 3, connectorId: 1 }))).toEqual({
      stationId: 'CS-1',
      connectorId: 3,
    });
    expect(mappedArgs(to16('ocppv21_UnlockConnector', { evseId: 3, connectorId: 3 }))).toEqual({
      stationId: 'CS-1',
      connectorId: 3,
    });
    expect(reason(to16('ocppv21_UnlockConnector', { evseId: 3, connectorId: 2 }))).toContain(
      'by its EVSE number only',
    );
  });

  it('translates a remote start with a profile and refuses what 1.6 cannot hold', () => {
    expect(
      mappedArgs(
        to16('ocppv21_RequestStartTransaction', {
          evseId: 1,
          idToken: { idToken: 'TAG', type: 'ISO14443' },
          chargingProfile: { ...PROFILE_21, chargingProfilePurpose: 'TxProfile' },
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      connectorId: 1,
      idTag: 'TAG',
      chargingProfile: {
        chargingProfileId: 5,
        transactionId: 12,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 7000 }] },
      },
    });
    expect(
      reason(
        to16('ocppv21_RequestStartTransaction', {
          idToken: { idToken: 'T' },
          groupIdToken: { idToken: 'G' },
        }),
      ),
    ).toContain('group id token');
    expect(
      reason(to16('ocppv21_RequestStartTransaction', { idToken: { idToken: 'x'.repeat(21) } })),
    ).toContain('at most 20 characters');
    expect(reason(to16('ocppv21_RequestStartTransaction', {}))).toContain('at most 20');
  });

  it('refuses 2.1 profiles 1.6 cannot hold', () => {
    const cases: [unknown, string][] = [
      [undefined, 'the charging profile is missing'],
      [{ ...PROFILE_21, foo: 1 }, 'the charging profile field foo'],
      [{ ...PROFILE_21, chargingProfileKind: 'Dynamic' }, 'Dynamic charging profile kind'],
      [{ ...PROFILE_21, chargingProfilePurpose: 'PriorityCharging' }, 'purpose has no equivalent'],
      [{ ...PROFILE_21, chargingSchedule: [] }, 'exactly one charging schedule'],
      [{ ...PROFILE_21, chargingSchedule: [1] }, 'exactly one charging schedule'],
      [
        { ...PROFILE_21, chargingSchedule: [{ chargingSchedulePeriod: [], extra: 1 }] },
        'the charging schedule field extra',
      ],
      [{ ...PROFILE_21, chargingSchedule: [{}] }, 'the charging schedule has no periods'],
      [{ ...PROFILE_21, transactionId: 'abc' }, 'numeric transaction id'],
      [{ ...PROFILE_21, transactionId: '9999999999' }, 'numeric transaction id'],
    ];
    for (const [profile, text] of cases) {
      expect(reason(to16('ocppv21_SetChargingProfile', { chargingProfile: profile }))).toContain(
        text,
      );
    }
    expect(
      mappedArgs(
        to16('ocppv21_SetChargingProfile', {
          chargingProfile: { ...PROFILE_21, transactionId: undefined },
        }),
      ),
    ).toMatchObject({ connectorId: 0, csChargingProfiles: { chargingProfileId: 5 } });
  });

  it('translates stop only for a numeric transaction id', () => {
    expect(mappedArgs(to16('ocppv21_RequestStopTransaction', { transactionId: '42' }))).toEqual({
      stationId: 'CS-1',
      transactionId: 42,
    });
    expect(reason(to16('ocppv21_RequestStopTransaction', { transactionId: 'tx-a' }))).toContain(
      'numeric transaction id',
    );
  });

  it('translates triggers to the plain or extended 1.6 trigger', () => {
    expect(
      to16('ocppv21_TriggerMessage', { requestedMessage: 'Heartbeat', evse: { id: 1 } }),
    ).toEqual({
      kind: 'mapped',
      operationId: 'ocppv16_TriggerMessage',
      args: { stationId: 'CS-1', requestedMessage: 'Heartbeat', connectorId: 1 },
    });
    expect(to16('ocppv21_TriggerMessage', { requestedMessage: 'LogStatusNotification' })).toEqual({
      kind: 'mapped',
      operationId: 'ocppv16_ExtendedTriggerMessage',
      args: { stationId: 'CS-1', requestedMessage: 'LogStatusNotification' },
    });
    expect(reason(to16('ocppv21_TriggerMessage', { customTrigger: 'x' }))).toContain('custom');
    expect(reason(to16('ocppv21_TriggerMessage', { requestedMessage: 'Foo' }))).toContain(
      'the Foo trigger',
    );
  });

  it('translates composite schedules and the plain tools', () => {
    expect(mappedArgs(to16('ocppv21_GetCompositeSchedule', { evseId: 0, duration: 30 }))).toEqual({
      stationId: 'CS-1',
      connectorId: 0,
      duration: 30,
    });
    expect(to16('ocppv21_CancelReservation', { reservationId: 1 })).toEqual({
      kind: 'mapped',
      operationId: 'ocppv16_CancelReservation',
      args: { stationId: 'CS-1', reservationId: 1 },
    });
  });

  it('translates ClearChargingProfile criteria', () => {
    expect(
      mappedArgs(
        to16('ocppv21_ClearChargingProfile', {
          chargingProfileId: 2,
          chargingProfileCriteria: {
            evseId: 1,
            chargingProfilePurpose: 'TxDefaultProfile',
            stackLevel: 0,
          },
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      id: 2,
      connectorId: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      stackLevel: 0,
    });
    expect(mappedArgs(to16('ocppv21_ClearChargingProfile', {}))).toEqual({ stationId: 'CS-1' });
    expect(
      reason(to16('ocppv21_ClearChargingProfile', { chargingProfileCriteria: { source: 'x' } })),
    ).toContain('the criteria field source');
    expect(
      reason(
        to16('ocppv21_ClearChargingProfile', {
          chargingProfileCriteria: { chargingProfilePurpose: 'PriorityCharging' },
        }),
      ),
    ).toContain('the profile purpose has no equivalent');
  });

  it('translates ReserveNow and refuses what 1.6 cannot hold', () => {
    expect(
      mappedArgs(
        to16('ocppv21_ReserveNow', {
          id: 8,
          expiryDateTime: 'E',
          idToken: { idToken: 'T' },
          groupIdToken: { idToken: 'G' },
          evseId: 2,
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      connectorId: 2,
      expiryDate: 'E',
      idTag: 'T',
      parentIdTag: 'G',
      reservationId: 8,
    });
    expect(mappedArgs(to16('ocppv21_ReserveNow', { idToken: { idToken: 'T' } }))).toMatchObject({
      connectorId: 0,
    });
    expect(reason(to16('ocppv21_ReserveNow', { connectorType: 'cCCS1' }))).toContain(
      'connector type',
    );
    expect(
      reason(
        to16('ocppv21_ReserveNow', {
          idToken: { idToken: 'T' },
          groupIdToken: { idToken: 'g'.repeat(21) },
        }),
      ),
    ).toContain('at most 20');
  });

  it('translates SendLocalList entries and refuses what 1.6 cannot hold', () => {
    expect(
      mappedArgs(
        to16('ocppv21_SendLocalList', {
          versionNumber: 3,
          updateType: 'Full',
          localAuthorizationList: [
            { idToken: { idToken: 'A' } },
            {
              idToken: { idToken: 'B' },
              idTokenInfo: {
                status: 'Blocked',
                cacheExpiryDateTime: 'D',
                groupIdToken: { idToken: 'G' },
              },
            },
            { idToken: { idToken: 'C' }, idTokenInfo: { status: 'Accepted' } },
          ],
        }),
      ),
    ).toEqual({
      stationId: 'CS-1',
      listVersion: 3,
      updateType: 'Full',
      localAuthorizationList: [
        { idTag: 'A' },
        { idTag: 'B', idTagInfo: { status: 'Blocked', expiryDate: 'D', parentIdTag: 'G' } },
        { idTag: 'C', idTagInfo: { status: 'Accepted' } },
      ],
    });
    expect(mappedArgs(to16('ocppv21_SendLocalList', { versionNumber: 1 }))).toEqual({
      stationId: 'CS-1',
      listVersion: 1,
    });
    expect(
      reason(to16('ocppv21_SendLocalList', { localAuthorizationList: [{ idToken: {} }] })),
    ).toContain('at most 20');
    expect(
      reason(
        to16('ocppv21_SendLocalList', {
          localAuthorizationList: [
            { idToken: { idToken: 'A' }, idTokenInfo: { status: 'Unknown' } },
          ],
        }),
      ),
    ).toContain('the Unknown token status');
  });
});
