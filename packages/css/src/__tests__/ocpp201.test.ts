// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  CHARGING_LIMIT_SOURCES_201,
  ID_TOKEN_TYPES_201,
  isOcpp201Action,
  LOCATIONS_201,
  MEASURANDS_201,
  Ocpp201StationError,
  TRIGGER_REASONS_TO_201,
  toOcpp201StationRequest,
  toOcpp201StationResponse,
} from '../lib/ocpp201.js';
import { assertOcpp201 } from './ocpp201-schema.js';

type Definitions = Record<string, { enum: string[] }>;

function definitions(version: '2.0.1' | '2.1', file: string): Definitions {
  const schema = JSON.parse(
    readFileSync(
      new URL(`../../../../schemas/ocpp-${version}/${file}.json`, import.meta.url),
      'utf8',
    ),
  ) as { definitions: Definitions };
  return schema.definitions;
}

function enumOf(version: '2.0.1' | '2.1', file: string, def: string): string[] {
  return (definitions(version, file)[def] as { enum: string[] }).enum;
}

const now = '2026-10-17T10:00:00.000Z';

function sample(over: Record<string, unknown>): Record<string, unknown> {
  return { value: 1, measurand: 'Energy.Active.Import.Register', ...over };
}

describe('OCPP 2.0.1 value lists', () => {
  it('match the 2.0.1 schemas', () => {
    expect([...MEASURANDS_201].sort()).toEqual(
      enumOf('2.0.1', 'MeterValuesRequest', 'MeasurandEnumType').sort(),
    );
    expect([...LOCATIONS_201].sort()).toEqual(
      enumOf('2.0.1', 'MeterValuesRequest', 'LocationEnumType').sort(),
    );
    expect([...ID_TOKEN_TYPES_201].sort()).toEqual(
      enumOf('2.0.1', 'AuthorizeRequest', 'IdTokenEnumType').sort(),
    );
    expect([...CHARGING_LIMIT_SOURCES_201].sort()).toEqual(
      enumOf('2.0.1', 'ClearedChargingLimitRequest', 'ChargingLimitSourceEnumType').sort(),
    );
  });

  it('knows which 2.1 messages 2.0.1 defines', () => {
    const dir = (v: string): string[] =>
      readdirSync(new URL(`../../../../schemas/ocpp-${v}/`, import.meta.url)).filter(
        (f) => !f.endsWith('Response.json'),
      );
    const actions201 = new Set(dir('2.0.1').map((f) => f.replace(/(Request)?\.json$/, '')));
    const actions21 = dir('2.1').map((f) => f.replace(/(Request)?\.json$/, ''));
    expect(actions21).toContain('NotifyPeriodicEventStream');
    for (const action of actions21) {
      expect(isOcpp201Action(action), action).toBe(actions201.has(action));
    }
  });

  it('maps every 2.1-only trigger reason to a 2.0.1 one', () => {
    const t201 = enumOf('2.0.1', 'TransactionEventRequest', 'TriggerReasonEnumType');
    const t21 = enumOf('2.1', 'TransactionEventRequest', 'TriggerReasonEnumType');
    expect(Object.keys(TRIGGER_REASONS_TO_201).sort()).toEqual(
      t21.filter((t) => !t201.includes(t)).sort(),
    );
    for (const target of Object.values(TRIGGER_REASONS_TO_201)) expect(t201).toContain(target);
  });
});

describe('toOcpp201StationRequest', () => {
  it('fits a 2.1 TransactionEvent to 2.0.1', () => {
    const out = toOcpp201StationRequest('TransactionEvent', {
      eventType: 'Ended',
      timestamp: now,
      triggerReason: 'CostLimitReached',
      seqNo: 3,
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'TOKEN1', type: 'ISO14443' },
      costDetails: {
        totalCost: { currency: 'EUR', typeOfCost: 'NormalCost', total: { exclTax: 1 } },
      },
      evseSleep: false,
      preconditioningStatus: 'Unknown',
      transactionInfo: {
        transactionId: 'tx-1',
        stoppedReason: 'ReqEnergyTransferRejected',
        operationMode: 'ChargingOnly',
        tariffId: 't1',
        transactionLimit: { maxCost: 10 },
      },
      meterValue: [
        {
          timestamp: now,
          sampledValue: [
            sample({}),
            sample({ measurand: 'Display.PresentSOC' }),
            sample({ location: 'Upstream' }),
            sample({
              signedMeterValue: { signedMeterData: 'abc', encodingMethod: 'OCMF' },
            }),
          ],
        },
        { timestamp: now, sampledValue: [sample({ measurand: 'Voltage.Minimum' })] },
      ],
    });
    expect(out).not.toBeNull();
    const p = out as Record<string, unknown>;
    assertOcpp201('TransactionEvent', 'request', p);
    expect(p['triggerReason']).toBe('EnergyLimitReached');
    expect(p['transactionInfo']).toEqual({ transactionId: 'tx-1', stoppedReason: 'Other' });
    const mv = p['meterValue'] as Array<{ sampledValue: unknown[] }>;
    expect(mv).toHaveLength(1);
    expect(mv[0]?.sampledValue).toHaveLength(2);
  });

  it('is needed: the raw 2.1 payload fails the 2.0.1 schema', () => {
    const raw = {
      eventType: 'Updated',
      timestamp: now,
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: { transactionId: 'tx-1' },
    };
    expect(() => assertOcpp201('TransactionEvent', 'request', raw)).toThrow(/2\.0\.1 schema/);
    assertOcpp201(
      'TransactionEvent',
      'request',
      toOcpp201StationRequest('TransactionEvent', raw) as Record<string, unknown>,
    );
  });

  it('leaves the payload of the caller unchanged', () => {
    const payload = { eventType: 'Updated', triggerReason: 'LimitSet', evseSleep: true };
    toOcpp201StationRequest('TransactionEvent', payload);
    expect(payload).toEqual({ eventType: 'Updated', triggerReason: 'LimitSet', evseSleep: true });
  });

  it('refuses an idToken type 2.0.1 does not define', () => {
    expect(() =>
      toOcpp201StationRequest('Authorize', { idToken: { idToken: 'VIN1', type: 'VIN' } }),
    ).toThrow(Ocpp201StationError);
    expect(() =>
      toOcpp201StationRequest('Authorize', { idToken: { idToken: 'x'.repeat(37), type: 'Local' } }),
    ).toThrow(/longer than 36/);
  });

  it('sends nothing for a MeterValues of 2.1-only measurands', () => {
    expect(
      toOcpp201StationRequest('MeterValues', {
        evseId: 1,
        meterValue: [
          { timestamp: now, sampledValue: [sample({ measurand: 'Power.Active.Setpoint' })] },
        ],
      }),
    ).toBeNull();
  });

  it('fits the other station requests', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'NotifyReport',
        {
          requestId: 1,
          generatedAt: now,
          seqNo: 0,
          reportData: [
            {
              component: { name: 'TariffCostCtrlr' },
              variable: { name: 'Enabled' },
              variableAttribute: [{ value: 'true' }],
              variableCharacteristics: {
                dataType: 'boolean',
                supportsMonitoring: false,
                maxElements: 3,
              },
            },
          ],
        },
      ],
      [
        'NotifyMonitoringReport',
        {
          requestId: 1,
          generatedAt: now,
          seqNo: 0,
          monitor: [
            {
              component: { name: 'EVSE' },
              variable: { name: 'Power' },
              variableMonitoring: [
                {
                  id: 1,
                  transaction: false,
                  value: 1,
                  type: 'Delta',
                  severity: 5,
                  eventNotificationType: 'CustomMonitor',
                },
                {
                  id: 2,
                  transaction: false,
                  value: 1,
                  type: 'TargetDelta',
                  severity: 5,
                  eventNotificationType: 'CustomMonitor',
                },
              ],
            },
          ],
        },
      ],
      [
        'NotifyEvent',
        {
          generatedAt: now,
          seqNo: 0,
          eventData: [
            {
              eventId: 1,
              timestamp: now,
              trigger: 'Alerting',
              actualValue: 'true',
              component: { name: 'Connector' },
              variable: { name: 'Available' },
              eventNotificationType: 'HardWiredNotification',
              severity: 3,
            },
          ],
        },
      ],
      [
        'NotifyEVChargingNeeds',
        {
          evseId: 1,
          timestamp: now,
          chargingNeeds: {
            requestedEnergyTransfer: 'AC_single_phase',
            controlMode: 'ScheduledControl',
            mobilityNeedsMode: 'EVCC',
            availableEnergyTransfer: ['AC_single_phase'],
          },
        },
      ],
      [
        'NotifyEVChargingSchedule',
        {
          timeBase: now,
          evseId: 1,
          selectedChargingScheduleId: 1,
          powerToleranceAcceptance: true,
          chargingSchedule: {
            id: 1,
            chargingRateUnit: 'W',
            useLocalTime: false,
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000, limit_L2: 11000 }],
          },
        },
      ],
      [
        'NotifyChargingLimit',
        {
          evseId: 1,
          chargingLimit: {
            chargingLimitSource: 'CSO',
            isGridCritical: false,
            isLocalGeneration: false,
          },
        },
      ],
      [
        'ReportChargingProfiles',
        {
          requestId: 1,
          chargingLimitSource: 'CSO',
          evseId: 1,
          chargingProfile: [
            {
              id: 1,
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Relative',
              maxOfflineDuration: 60,
              chargingSchedule: [
                {
                  id: 1,
                  chargingRateUnit: 'W',
                  randomizedDelay: 0,
                  chargingSchedulePeriod: [
                    { startPeriod: 0, limit: 11000, operationMode: 'ChargingOnly' },
                  ],
                },
              ],
            },
            {
              id: 2,
              stackLevel: 0,
              chargingProfilePurpose: 'PriorityCharging',
              chargingProfileKind: 'Absolute',
              chargingSchedule: [
                {
                  id: 2,
                  chargingRateUnit: 'W',
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: 1 }],
                },
              ],
            },
          ],
        },
      ],
      [
        'NotifyDisplayMessages',
        {
          requestId: 1,
          messageInfo: [
            {
              id: 1,
              priority: 'NormalCycle',
              message: { format: 'UTF8', content: 'Hi' },
              messageExtra: [],
            },
            { id: 2, priority: 'NormalCycle', message: { format: 'QRCODE', content: 'https://x' } },
            {
              id: 3,
              priority: 'NormalCycle',
              state: 'Suspended',
              message: { format: 'UTF8', content: 'S' },
            },
          ],
        },
      ],
      [
        'FirmwareStatusNotification',
        { status: 'Installed', requestId: 1, statusInfo: { reasonCode: 'OK' } },
      ],
      [
        'LogStatusNotification',
        { status: 'Uploaded', requestId: 1, statusInfo: { reasonCode: 'OK' } },
      ],
      [
        'PublishFirmwareStatusNotification',
        { status: 'Published', statusInfo: { reasonCode: 'OK' } },
      ],
      [
        'Get15118EVCertificate',
        {
          iso15118SchemaVersion: '15118-20:2022',
          action: 'Install',
          exiRequest: 'exi',
          maximumContractCertificateChains: 1,
          prioritizedEMAIDs: ['EMAID1'],
        },
      ],
      [
        'SignCertificate',
        { csr: 'csr', certificateType: 'ChargingStationCertificate', requestId: 9 },
      ],
      ['ReservationStatusUpdate', { reservationId: 1, reservationUpdateStatus: 'NoTransaction' }],
    ];
    for (const [action, payload] of cases) {
      const out = toOcpp201StationRequest(action, payload);
      expect(out, action).not.toBeNull();
      assertOcpp201(action, 'request', out as Record<string, unknown>);
    }
  });

  it('refuses a request whose meaning 2.0.1 cannot carry', () => {
    expect(() =>
      toOcpp201StationRequest('NotifyEVChargingNeeds', {
        evseId: 1,
        chargingNeeds: { requestedEnergyTransfer: 'AC_BPT' },
      }),
    ).toThrow(/AC_BPT/);
    expect(() =>
      toOcpp201StationRequest('SignCertificate', { csr: 'c', certificateType: 'V2G20Certificate' }),
    ).toThrow(/V2G20Certificate/);
    expect(() =>
      toOcpp201StationRequest('ClearedChargingLimit', { chargingLimitSource: 'LocalGeneration' }),
    ).toThrow(/chargingLimitSource/);
  });
});

describe('toOcpp201StationResponse', () => {
  it('fits station replies to 2.0.1', () => {
    const long = 'x'.repeat(900);
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'RequestStartTransaction',
        { status: 'Rejected', statusInfo: { reasonCode: 'Busy', additionalInfo: long } },
      ],
      [
        'GetVariables',
        {
          getVariableResult: [
            {
              attributeStatus: 'Rejected',
              attributeStatusInfo: { reasonCode: 'WriteOnly', additionalInfo: long },
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
            },
          ],
        },
      ],
      ['ClearDisplayMessage', { status: 'Rejected' }],
      ['SetDisplayMessage', { status: 'LanguageNotSupported' }],
      [
        'GetCompositeSchedule',
        {
          status: 'Accepted',
          schedule: {
            evseId: 1,
            duration: 60,
            scheduleStart: now,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 11000, limit_L2: 11000, setpoint: 1 },
            ],
          },
        },
      ],
      [
        'GetInstalledCertificateIds',
        {
          status: 'Accepted',
          certificateHashDataChain: [
            {
              certificateType: 'OEMRootCertificate',
              certificateHashData: {
                hashAlgorithm: 'SHA256',
                issuerNameHash: 'a',
                issuerKeyHash: 'b',
                serialNumber: '1',
              },
            },
          ],
        },
      ],
    ];
    for (const [action, payload] of cases) {
      assertOcpp201(action, 'response', toOcpp201StationResponse(action, payload));
    }
    expect(toOcpp201StationResponse('ClearDisplayMessage', { status: 'Rejected' })).toEqual({
      status: 'Unknown',
    });
    expect(
      toOcpp201StationResponse('GetInstalledCertificateIds', {
        status: 'Accepted',
        certificateHashDataChain: [{ certificateType: 'OEMRootCertificate' }],
      }),
    ).toEqual({ status: 'NotFound' });
  });
});
