// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ocpp201MappingLosses } from '../ocpp201-mapping-check.js';
import { createTestClient } from '../client.js';

describe('ocpp201MappingLosses', () => {
  it('reports nothing for an unchanged payload, and ignores fields the edge adds', () => {
    expect(ocpp201MappingLosses({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } })).toEqual([]);
    expect(ocpp201MappingLosses({ a: 1 }, { a: 1, signingMethod: '' })).toEqual([]);
    expect(ocpp201MappingLosses({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
  });

  it('reports removed fields, changed values and removed items by path', () => {
    expect(
      ocpp201MappingLosses(
        {
          triggerReason: 'RunningCost',
          transactionInfo: { transactionId: 't', tariffId: 'x' },
          meterValue: [{ sampledValue: [{ value: 1 }, { value: 2, measurand: 'Power.Reactive' }] }],
        },
        {
          triggerReason: 'MeterValuePeriodic',
          transactionInfo: { transactionId: 't' },
          meterValue: [{ sampledValue: [{ value: 1 }] }],
        },
      ),
    ).toEqual([
      'triggerReason "RunningCost" -> "MeterValuePeriodic"',
      'transactionInfo.tariffId removed',
      'meterValue[0].sampledValue 1 of 2 items removed',
    ]);
  });

  it('reports a message the edge does not send at all', () => {
    expect(ocpp201MappingLosses({ meterValue: [] }, null)).toEqual([
      'message not sent (nothing of it exists in OCPP 2.0.1)',
    ]);
  });
});

describe('TestOcppClient OCPP 2.0.1 mapping check', () => {
  const event = {
    generatedAt: '2026-10-19T00:00:00.000Z',
    seqNo: 0,
    eventData: [
      {
        eventId: 1,
        timestamp: '2026-10-19T00:00:00.000Z',
        trigger: 'Delta',
        actualValue: 'Available',
        component: { name: 'Connector' },
        variable: { name: 'AvailabilityState' },
        eventNotificationType: 'HardWiredNotification',
        severity: 2,
      },
    ],
  };

  it('records what the 2.0.1 edge removed from a station message and a reply', () => {
    const client = createTestClient({
      serverUrl: 'ws://localhost:1',
      stationId: 'OCTT-CHECK',
      version: 'ocpp2.0.1',
    });
    const wire = client.callPayload('NotifyEvent', event);
    expect(wire?.['eventData']).toEqual([
      expect.not.objectContaining({ severity: expect.anything() }),
    ]);
    client.callResultPayload('FirmwareStatusNotification', {});
    client.callResultPayload('GetLog', {
      status: 'Accepted',
      statusInfo: { reasonCode: 'x', additionalInfo: 'a'.repeat(600) },
    });
    expect(client.mappingLosses).toEqual([
      'NotifyEventRequest: eventData[0].severity removed',
      expect.stringMatching(/^GetLogResponse: statusInfo\.additionalInfo /),
    ]);
  });

  it('records nothing for an OCPP 2.1 client', () => {
    const client = createTestClient({
      serverUrl: 'ws://localhost:1',
      stationId: 'OCTT-CHECK',
      version: 'ocpp2.1',
    });
    expect(client.callPayload('NotifyEvent', event)).toEqual(event);
    expect(client.mappingLosses).toEqual([]);
  });
});
