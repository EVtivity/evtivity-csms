// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ActionRegistry as Registry201 } from '../generated/v2_0_1/registry.js';
import {
  Ocpp201CommandError,
  ocpp201RequestBoundErrors,
  prepareOcpp201Command,
  toOcpp201Command,
  toOcpp201Reply,
} from '../server/ocpp201/to-ocpp201.js';

type Obj = Record<string, unknown>;

function validReply201(action: keyof typeof Registry201, reply: Obj): boolean {
  return Registry201[action].validateResponse(reply);
}

describe('toOcpp201Reply', () => {
  it('drops the 2.1-only Authorize reply fields and leaves the handler object unchanged', () => {
    const reply = {
      idTokenInfo: { status: 'Accepted', customData: { vendorId: 'v', extra: 1 } },
      tariff: { tariffId: 't1', currency: 'EUR' },
    };

    expect(toOcpp201Reply('Authorize', reply)).toEqual({
      idTokenInfo: { status: 'Accepted', customData: { vendorId: 'v', extra: 1 } },
    });
    expect(reply).toHaveProperty('tariff');
  });

  it('drops the 2.1-only TransactionEvent reply fields', () => {
    const reply = {
      totalCost: 1.5,
      transactionLimit: { maxCost: 10 },
      updatedPersonalMessageExtra: [{ format: 'UTF8', content: 'hi' }],
    };

    expect(toOcpp201Reply('TransactionEvent', reply)).toEqual({ totalCost: 1.5 });
  });

  it('returns the payload of an action 2.0.1 does not define unchanged', () => {
    const reply = { status: 'Accepted' };

    expect(toOcpp201Reply('NotifyDERAlarm', reply)).toBe(reply);
    expect(toOcpp201Reply('constructor', reply)).toBe(reply);
  });

  it('leaves out a group token whose type 2.0.1 does not define', () => {
    const reply = {
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G1', type: 'DirectPayment' } },
    };

    const mapped = toOcpp201Reply('Authorize', reply);

    expect(mapped).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(validReply201('Authorize', mapped)).toBe(true);
    expect(reply.idTokenInfo).toHaveProperty('groupIdToken');
  });

  it('leaves out a group token longer than 36 characters and keeps a valid one', () => {
    const long = { idToken: 'G'.repeat(37), type: 'Central' };
    const valid = { idToken: 'G1', type: 'Central' };

    expect(
      toOcpp201Reply('Authorize', { idTokenInfo: { status: 'Accepted', groupIdToken: long } }),
    ).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(
      toOcpp201Reply('Authorize', { idTokenInfo: { status: 'Accepted', groupIdToken: valid } }),
    ).toEqual({ idTokenInfo: { status: 'Accepted', groupIdToken: valid } });
  });

  it('leaves out a QR code personal message and cuts a long text to 512 characters', () => {
    const qr = toOcpp201Reply('Authorize', {
      idTokenInfo: { status: 'Accepted', personalMessage: { format: 'QRCODE', content: 'x' } },
    });
    const long = toOcpp201Reply('Authorize', {
      idTokenInfo: {
        status: 'Accepted',
        personalMessage: { format: 'UTF8', content: 'a'.repeat(1024) },
      },
    });

    expect(qr).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(long).toEqual({
      idTokenInfo: {
        status: 'Accepted',
        personalMessage: { format: 'UTF8', content: 'a'.repeat(512) },
      },
    });
    expect(validReply201('Authorize', long)).toBe(true);
  });

  it('maps the TransactionEvent personal messages', () => {
    const mapped = toOcpp201Reply('TransactionEvent', {
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G', type: 'EVCCID' } },
      updatedPersonalMessage: { format: 'QRCODE', content: 'https://pay' },
      totalCost: 2,
    });

    expect(mapped).toEqual({ idTokenInfo: { status: 'Accepted' }, totalCost: 2 });
    expect(validReply201('TransactionEvent', mapped)).toBe(true);
  });

  it('cuts statusInfo.additionalInfo to 512 characters', () => {
    const mapped = toOcpp201Reply('BootNotification', {
      currentTime: '2026-10-17T10:00:00Z',
      interval: 300,
      status: 'Accepted',
      statusInfo: { reasonCode: 'X', additionalInfo: 'i'.repeat(1000) },
    });

    expect((mapped['statusInfo'] as Obj)['additionalInfo']).toBe('i'.repeat(512));
    expect(validReply201('BootNotification', mapped)).toBe(true);
  });

  it('answers the 2.1 NoChargingProfile as the 2.0.1 Rejected', () => {
    const mapped = toOcpp201Reply('NotifyEVChargingNeeds', { status: 'NoChargingProfile' });

    expect(mapped).toEqual({ status: 'Rejected' });
    expect(validReply201('NotifyEVChargingNeeds', mapped)).toBe(true);
  });
});

describe('ocpp201RequestBoundErrors', () => {
  it('names a negative evseId the 2.0.1 schema leaves open', () => {
    const errors = ocpp201RequestBoundErrors('StatusNotification', {
      timestamp: '2026-10-17T10:00:00Z',
      connectorStatus: 'Available',
      evseId: -1,
      connectorId: 1,
    });

    expect(errors.map((e) => [e.instancePath, e.keyword])).toEqual([['/evseId', 'minimum']]);
  });

  it('ignores what only 2.1 requires (eventNotificationType)', () => {
    const errors = ocpp201RequestBoundErrors('NotifyMonitoringReport', {
      requestId: 1,
      seqNo: 0,
      generatedAt: '2026-10-17T10:00:00Z',
      monitor: [
        {
          component: { name: 'EVSE' },
          variable: { name: 'Power' },
          variableMonitoring: [
            { id: 1, transaction: false, value: 10, type: 'UpperThreshold', severity: 5 },
          ],
        },
      ],
    });

    expect(errors).toEqual([]);
  });
});

const profile = (period: Obj = { startPeriod: 0, limit: 11000 }, extra: Obj = {}): Obj => ({
  id: 1,
  stackLevel: 0,
  chargingProfilePurpose: 'TxDefaultProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [
    {
      id: 1,
      startSchedule: '2026-10-17T10:00:00Z',
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [period],
    },
  ],
  ...extra,
});

function refusal(action: string, payload: Obj): string {
  try {
    prepareOcpp201Command(action, payload);
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(Ocpp201CommandError);
    return (err as Error).message;
  }
  throw new Error(`${action} was not refused`);
}

describe('prepareOcpp201Command', () => {
  it('refuses an action only OCPP 2.1 defines', () => {
    expect(refusal('GetTariffs', { evseId: 1 })).toBe(
      'GetTariffs cannot be sent to an OCPP 2.0.1 station: the action is defined in OCPP 2.1 only',
    );
    expect(refusal('ChangeConfiguration', {})).toContain('not defined in OCPP 2.0.1');
  });

  it('drops operationMode ChargingOnly and other defaults from a charging profile', () => {
    const period = {
      startPeriod: 0,
      limit: 11000,
      limit_L2: 11000,
      operationMode: 'ChargingOnly',
      evseSleep: false,
    };
    const input = {
      evseId: 1,
      chargingProfile: profile(period, { invalidAfterOfflineDuration: false }),
    };

    const sent = prepareOcpp201Command('SetChargingProfile', input);

    expect(sent).toEqual({ evseId: 1, chargingProfile: profile() });
    expect(input.chargingProfile).toHaveProperty('invalidAfterOfflineDuration');
  });

  it('refuses a negative limit (a 2.1 discharge limit) on both profile commands', () => {
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile({ startPeriod: 0, limit: -5000 }),
      }),
    ).toContain('limit -5000 is a discharge limit, OCPP 2.0.1 has no discharging');
    expect(
      refusal('RequestStartTransaction', {
        remoteStartId: 1,
        idToken: { idToken: 'TAG', type: 'ISO14443' },
        chargingProfile: {
          ...profile({ startPeriod: 0, limit: -1 }),
          chargingProfilePurpose: 'TxProfile',
        },
      }),
    ).toContain('is a discharge limit');
  });

  it('refuses a period without a limit, a setpoint, and a per-phase limit that differs', () => {
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile({ startPeriod: 0, setpoint: 5000 }),
      }),
    ).toContain('chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].setpoint');
    expect(
      refusal('SetChargingProfile', { evseId: 1, chargingProfile: profile({ startPeriod: 0 }) }),
    ).toContain('limit is required in OCPP 2.0.1');
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile({ startPeriod: 0, limit: 16, limit_L2: 10 }),
      }),
    ).toContain('limit_L2 is not defined in OCPP 2.0.1');
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile({ startPeriod: 0, limit: 16, operationMode: 'CentralSetpoint' }),
      }),
    ).toContain('operationMode');
  });

  it('refuses the 2.1-only kind, purposes and profile fields', () => {
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile(undefined, { chargingProfileKind: 'Dynamic' }),
      }),
    ).toContain('chargingProfileKind Dynamic');
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile(undefined, { chargingProfilePurpose: 'PriorityCharging' }),
      }),
    ).toContain('PriorityCharging');
    expect(
      refusal('SetChargingProfile', {
        evseId: 1,
        chargingProfile: profile(undefined, { maxOfflineDuration: 60 }),
      }),
    ).toContain('maxOfflineDuration');
    expect(
      refusal('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'LocalGeneration' },
      }),
    ).toContain('LocalGeneration');
  });

  it('refuses a RequestStartTransaction token 2.0.1 cannot carry', () => {
    expect(
      refusal('RequestStartTransaction', {
        remoteStartId: 1,
        idToken: { idToken: 'T', type: 'DirectPayment' },
      }),
    ).toContain('idToken.type DirectPayment is not an OCPP 2.0.1 token type');
    expect(
      refusal('RequestStartTransaction', {
        remoteStartId: 1,
        idToken: { idToken: 'T'.repeat(37), type: 'Central' },
      }),
    ).toContain('longer than 36');
    expect(
      prepareOcpp201Command('RequestStartTransaction', {
        remoteStartId: 1,
        evseId: 1,
        idToken: { idToken: 'T1', type: 'Central' },
        chargingProfile: { ...profile(), chargingProfilePurpose: 'TxProfile' },
      }),
    ).toHaveProperty('idToken', { idToken: 'T1', type: 'Central' });
  });

  it('refuses a QR code, a long text and a 2.1-only state in SetDisplayMessage, and drops messageExtra', () => {
    const message = (content: Obj, extra: Obj = {}): Obj => ({
      message: { id: 1, priority: 'NormalCycle', message: content, ...extra },
    });

    expect(refusal('SetDisplayMessage', message({ format: 'QRCODE', content: 'x' }))).toContain(
      'QRCODE',
    );
    expect(
      refusal('SetDisplayMessage', message({ format: 'UTF8', content: 'x'.repeat(513) })),
    ).toContain('longer than 512');
    expect(
      refusal(
        'SetDisplayMessage',
        message({ format: 'UTF8', content: 'x' }, { state: 'Suspended' }),
      ),
    ).toContain('message.state Suspended');
    expect(
      prepareOcpp201Command(
        'SetDisplayMessage',
        message(
          { format: 'UTF8', content: 'Hi' },
          { messageExtra: [{ format: 'UTF8', language: 'de', content: 'Hallo' }] },
        ),
      ),
    ).toEqual(message({ format: 'UTF8', content: 'Hi' }));
  });

  it('sets the network profile version to OCPP20 and refuses what only 2.1 has', () => {
    const data = (extra: Obj = {}): Obj => ({
      configurationSlot: 1,
      connectionData: {
        ocppTransport: 'JSON',
        ocppCsmsUrl: 'wss://csms.example/ocpp',
        messageTimeout: 30,
        securityProfile: 1,
        ocppInterface: 'Wired0',
        ...extra,
      },
    });

    expect(prepareOcpp201Command('SetNetworkProfile', data())).toEqual(
      data({ ocppVersion: 'OCPP20' }),
    );
    expect(prepareOcpp201Command('SetNetworkProfile', data({ ocppVersion: 'OCPP201' }))).toEqual(
      data({ ocppVersion: 'OCPP20' }),
    );
    expect(refusal('SetNetworkProfile', data({ ocppVersion: 'OCPP21' }))).toContain('OCPP21');
    expect(refusal('SetNetworkProfile', data({ basicAuthPassword: 'p'.repeat(16) }))).toContain(
      'SetVariables',
    );
    expect(refusal('SetNetworkProfile', data({ identity: 'CS-1' }))).toContain('identity');
    expect(refusal('SetNetworkProfile', data({ ocppInterface: 'Any' }))).toContain('Any');
    expect(
      refusal('SetNetworkProfile', data({ ocppCsmsUrl: `wss://${'a'.repeat(510)}` })),
    ).toContain('does not match the OCPP 2.0.1 schema: /connectionData/ocppCsmsUrl');
  });

  it('refuses the 2.1-only enum values of other commands', () => {
    expect(refusal('TriggerMessage', { requestedMessage: 'CustomTrigger' })).toContain(
      'CustomTrigger',
    );
    expect(
      refusal('TriggerMessage', { requestedMessage: 'BootNotification', customTrigger: 'x' }),
    ).toContain('customTrigger is not defined');
    expect(refusal('Reset', { type: 'ImmediateAndResume' })).toContain('ImmediateAndResume');
    expect(
      refusal('GetLog', {
        logType: 'DataCollectorLog',
        requestId: 1,
        log: { remoteLocation: 'ftp://x' },
      }),
    ).toContain('DataCollectorLog');
    expect(
      refusal('SetVariableMonitoring', {
        setMonitoringData: [
          {
            value: 1,
            type: 'TargetDelta',
            severity: 5,
            component: { name: 'EVSE' },
            variable: { name: 'Power' },
          },
        ],
      }),
    ).toContain('setMonitoringData[0].type TargetDelta');
    expect(
      refusal('InstallCertificate', { certificateType: 'OEMRootCertificate', certificate: 'x' }),
    ).toContain('OEMRootCertificate');
    expect(
      refusal('GetInstalledCertificateIds', { certificateType: ['OEMRootCertificate'] }),
    ).toContain('OEMRootCertificate');
    expect(
      refusal('CertificateSigned', { certificateChain: 'x', certificateType: 'V2G20Certificate' }),
    ).toContain('V2G20Certificate');
  });

  it('drops the CertificateSigned requestId', () => {
    expect(
      prepareOcpp201Command('CertificateSigned', {
        certificateChain: 'x',
        certificateType: 'ChargingStationCertificate',
        requestId: 7,
      }),
    ).toEqual({ certificateChain: 'x', certificateType: 'ChargingStationCertificate' });
  });

  it('refuses values over the 2.0.1 size limits with the schema reason', () => {
    expect(
      refusal('SetVariables', {
        setVariableData: [
          {
            attributeValue: 'v'.repeat(1001),
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'X' },
          },
        ],
      }),
    ).toContain('/setVariableData/0/attributeValue must NOT have more than 1000 characters');
    expect(
      refusal('InstallCertificate', {
        certificateType: 'CSMSRootCertificate',
        certificate: 'c'.repeat(5501),
      }),
    ).toContain('/certificate must NOT have more than 5500 characters');
  });

  it('passes a shared command that 2.0.1 already accepts', () => {
    const payload = { requestId: 1, reportBase: 'FullInventory' };

    expect(prepareOcpp201Command('GetBaseReport', payload)).toEqual(payload);
  });
});

describe('toOcpp201Command', () => {
  it('returns the payload of a command without 2.0.1 differences unchanged', () => {
    const payload = { type: 'OnIdle' };

    expect(toOcpp201Command('ClearCache', payload)).toBe(payload);
    expect(toOcpp201Command('constructor', payload)).toBe(payload);
  });
});
