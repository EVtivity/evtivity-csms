// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 2.0.1 command refusals and reply cuts not covered by to-ocpp201.test.ts:
// each refusal names the field, and each kept command is returned unchanged.

import { describe, expect, it } from 'vitest';
import {
  Ocpp201CommandError,
  toOcpp201Command,
  toOcpp201Reply,
} from '../server/ocpp201/to-ocpp201.js';

type Obj = Record<string, unknown>;

function refusal(action: string, payload: Obj): string {
  try {
    toOcpp201Command(action, payload);
    return 'kept';
  } catch (err) {
    expect(err).toBeInstanceOf(Ocpp201CommandError);
    return (err as Error).message;
  }
}

const TOKEN = { idToken: 'ABC', type: 'ISO14443' };
const LONG = 'x'.repeat(37);

describe('toOcpp201Command refusals', () => {
  it('refuses a token longer than 36 characters or with a long additional id', () => {
    expect(refusal('ReserveNow', { idToken: { ...TOKEN, idToken: LONG } })).toMatch(
      /idToken\.idToken is longer than 36/,
    );
    expect(
      refusal('CustomerInformation', {
        idToken: { ...TOKEN, additionalInfo: [{ additionalIdToken: LONG, type: 'x' }] },
      }),
    ).toMatch(/additionalInfo\.additionalIdToken is longer than 36/);
    expect(
      refusal('ReserveNow', { idToken: TOKEN, groupIdToken: { idToken: 'g', type: 'VIN' } }),
    ).toMatch(/groupIdToken\.type VIN is not an OCPP 2\.0\.1 token type/);
  });

  it('checks every local list entry and its token info', () => {
    expect(
      refusal('SendLocalList', {
        localAuthorizationList: [
          { idToken: TOKEN },
          {
            idToken: TOKEN,
            idTokenInfo: {
              status: 'Accepted',
              personalMessage: { format: 'QRCODE', content: 'q' },
            },
          },
        ],
      }),
    ).toMatch(/localAuthorizationList\[1\]\.idTokenInfo\.personalMessage\.format QRCODE/);
    expect(
      refusal('SendLocalList', {
        localAuthorizationList: [
          {
            idToken: TOKEN,
            idTokenInfo: {
              status: 'Accepted',
              personalMessage: { format: 'UTF8', content: 'y'.repeat(513) },
            },
          },
        ],
      }),
    ).toMatch(/personalMessage\.content is longer than 512/);
    expect(
      refusal('SendLocalList', {
        localAuthorizationList: [{ idToken: TOKEN, idTokenInfo: 'x' }],
      }),
    ).toBe('kept');
  });

  it('refuses 2.1-only profile purposes in the clear and get criteria', () => {
    expect(
      refusal('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'PriorityCharging' },
      }),
    ).toMatch(/chargingProfileCriteria\.chargingProfilePurpose PriorityCharging/);
    expect(
      refusal('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'LocalGeneration' },
      }),
    ).toMatch(/chargingProfile\.chargingProfilePurpose LocalGeneration/);
    expect(refusal('ClearChargingProfile', {})).toBe('kept');
    expect(refusal('GetChargingProfiles', { requestId: 1 })).toBe('kept');
  });

  it('refuses 2.1-only display message states and keeps a message without extras as is', () => {
    expect(
      refusal('SetDisplayMessage', {
        message: {
          id: 1,
          priority: 'InFront',
          state: 'Suspended',
          message: { format: 'UTF8', content: 'hi' },
        },
      }),
    ).toMatch(/message\.state Suspended/);
    expect(refusal('GetDisplayMessages', { requestId: 1, state: 'Discharging' })).toMatch(
      /state Discharging/,
    );
    const plain = {
      message: { id: 1, priority: 'InFront', message: { format: 'UTF8', content: 'hi' } },
    };
    expect(toOcpp201Command('SetDisplayMessage', plain)).toBe(plain);
    expect(toOcpp201Command('SetDisplayMessage', { message: 'x' })).toEqual({ message: 'x' });
  });

  it('refuses a 2.1-only network profile', () => {
    const base = { configurationSlot: 1, connectionData: { ocppTransport: 'JSON' } };
    expect(refusal('SetNetworkProfile', { ...base, connectionData: { identity: 'CS1' } })).toMatch(
      /connectionData\.identity/,
    );
    expect(
      refusal('SetNetworkProfile', { ...base, connectionData: { basicAuthPassword: 'p' } }),
    ).toMatch(/connectionData\.basicAuthPassword/);
    expect(
      refusal('SetNetworkProfile', { ...base, connectionData: { ocppInterface: 'Any' } }),
    ).toMatch(/ocppInterface Any/);
    expect(
      refusal('SetNetworkProfile', { ...base, connectionData: { ocppVersion: 'OCPP21' } }),
    ).toMatch(/ocppVersion OCPP21/);
    expect(
      toOcpp201Command('SetNetworkProfile', {
        ...base,
        connectionData: { ocppVersion: 'OCPP201' },
      }),
    ).toMatchObject({ connectionData: { ocppVersion: 'OCPP20' } });
    expect(toOcpp201Command('SetNetworkProfile', { configurationSlot: 1 })).toEqual({
      configurationSlot: 1,
    });
  });

  it('refuses 2.1-only enum values of the other commands', () => {
    expect(refusal('TriggerMessage', { requestedMessage: 'CustomTrigger' })).toMatch(
      /requestedMessage CustomTrigger/,
    );
    expect(
      refusal('TriggerMessage', { requestedMessage: 'Heartbeat', customTrigger: 'x' }),
    ).toMatch(/customTrigger is not defined/);
    expect(refusal('Reset', { type: 'ImmediateAndResume' })).toMatch(/type ImmediateAndResume/);
    expect(refusal('GetLog', { logType: 'DataCollectorLog' })).toMatch(/logType DataCollectorLog/);
    expect(
      refusal('SetVariableMonitoring', { setMonitoringData: [{ type: 'TargetDelta' }] }),
    ).toMatch(/setMonitoringData\[0\]\.type TargetDelta/);
    expect(
      refusal('SetVariableMonitoring', {
        setMonitoringData: [{ type: 'Delta', periodicEventStream: {} }],
      }),
    ).toMatch(/setMonitoringData\[0\]\.periodicEventStream/);
    expect(refusal('InstallCertificate', { certificateType: 'OEMRootCertificate' })).toMatch(
      /certificateType OEMRootCertificate/,
    );
    expect(
      refusal('GetInstalledCertificateIds', {
        certificateType: ['V2GRootCertificate', 'OEMRootCertificate'],
      }),
    ).toMatch(/OEMRootCertificate/);
    expect(refusal('GetInstalledCertificateIds', {})).toBe('kept');
    expect(refusal('CertificateSigned', { certificateType: 'V2G20Certificate' })).toMatch(
      /V2G20Certificate/,
    );
  });

  it('drops the 2.1 request id of a CertificateSigned, keeps one without it', () => {
    expect(
      toOcpp201Command('CertificateSigned', { certificateChain: 'pem', requestId: 7 }),
    ).toEqual({ certificateChain: 'pem' });
    const plain = { certificateChain: 'pem' };
    expect(toOcpp201Command('CertificateSigned', plain)).toBe(plain);
  });

  it('returns an unmapped action unchanged', () => {
    const p = { a: 1 };
    expect(toOcpp201Command('Heartbeat', p)).toBe(p);
  });
});

describe('toOcpp201Reply cuts', () => {
  it('cuts a long statusInfo text to 512 characters', () => {
    const reply = toOcpp201Reply('BootNotification', {
      currentTime: '2026-11-12T00:00:00Z',
      interval: 60,
      status: 'Accepted',
      statusInfo: { reasonCode: 'x', additionalInfo: 'z'.repeat(600) },
    });
    expect(((reply['statusInfo'] as Obj)['additionalInfo'] as string).length).toBe(512);
  });

  it('cuts a long personal message and drops a QR one and a group token 2.0.1 cannot carry', () => {
    const cut = toOcpp201Reply('Authorize', {
      idTokenInfo: {
        status: 'Accepted',
        personalMessage: { format: 'UTF8', content: 'm'.repeat(600) },
        groupIdToken: { idToken: 'g', type: 'VIN' },
      },
    });
    const info = cut['idTokenInfo'] as Obj;
    expect(((info['personalMessage'] as Obj)['content'] as string).length).toBe(512);
    expect(info).not.toHaveProperty('groupIdToken');
    const qr = toOcpp201Reply('Authorize', {
      idTokenInfo: { status: 'Accepted', personalMessage: { format: 'QRCODE', content: 'q' } },
    });
    expect(qr['idTokenInfo']).not.toHaveProperty('personalMessage');
    expect(toOcpp201Reply('Authorize', { idTokenInfo: 'x' })).toEqual({ idTokenInfo: 'x' });
  });

  it('maps the TransactionEvent personal message and the NoChargingProfile status', () => {
    const reply = toOcpp201Reply('TransactionEvent', {
      updatedPersonalMessage: { format: 'QRCODE', content: 'q' },
    });
    expect(reply).not.toHaveProperty('updatedPersonalMessage');
    expect(toOcpp201Reply('NotifyEVChargingNeeds', { status: 'NoChargingProfile' })).toEqual({
      status: 'Rejected',
    });
    expect(toOcpp201Reply('NotifyEVChargingNeeds', { status: 'Accepted' })).toEqual({
      status: 'Accepted',
    });
  });
});
