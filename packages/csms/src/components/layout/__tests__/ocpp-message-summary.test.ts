// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ERROR_DESCRIPTION_MAX,
  meterPowerKw,
  summarizeOcppMessage,
  type OcppMessageInput,
} from '../ocpp-message-summary';

function call(action: string, payload: unknown): OcppMessageInput {
  return { action, messageType: 2, payload, errorCode: null, errorDescription: null };
}

describe('summarizeOcppMessage', () => {
  it('names a 2.1 TransactionEvent by its event type, charging state and power', () => {
    const s = summarizeOcppMessage(
      call('TransactionEvent', {
        eventType: 'Updated',
        triggerReason: 'MeterValuePeriodic',
        transactionInfo: { transactionId: 't1', chargingState: 'Charging' },
        meterValue: [
          {
            timestamp: '2026-11-03T14:02:11Z',
            sampledValue: [
              { value: 1200, measurand: 'Energy.Active.Import.Register' },
              { value: 7200, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
            ],
          },
        ],
      }),
    );
    expect(s.parts).toEqual(['Updated', 'Charging', 'MeterValuePeriodic']);
    expect(s.powerKw).toBe(7.2);
    expect(s.dim).toBe(false);
    expect(s.error).toBe(false);
  });

  it('reads 2.1 and 1.6 StatusNotification', () => {
    expect(
      summarizeOcppMessage(
        call('StatusNotification', { evseId: 1, connectorId: 1, connectorStatus: 'Occupied' }),
      ).parts,
    ).toEqual(['EVSE 1/1', 'Occupied']);
    expect(
      summarizeOcppMessage(
        call('StatusNotification', {
          connectorId: 2,
          status: 'Faulted',
          errorCode: 'GroundFailure',
        }),
      ).parts,
    ).toEqual(['#2', 'Faulted', 'GroundFailure']);
    expect(
      summarizeOcppMessage(
        call('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' }),
      ).parts,
    ).toEqual(['#1', 'Available']);
  });

  it('reads MeterValues power in 1.6 (string, kW) and 2.1 (multiplier, phases)', () => {
    const v16 = summarizeOcppMessage(
      call('MeterValues', {
        connectorId: 1,
        meterValue: [
          { sampledValue: [{ value: '11.5', measurand: 'Power.Active.Import', unit: 'kW' }] },
        ],
      }),
    );
    expect(v16.parts).toEqual(['#1']);
    expect(v16.powerKw).toBe(11.5);
    const phases = meterPowerKw([
      {
        sampledValue: [
          {
            value: 2,
            measurand: 'Power.Active.Import',
            phase: 'L1',
            unitOfMeasure: { unit: 'W', multiplier: 3 },
          },
          {
            value: 2,
            measurand: 'Power.Active.Import',
            phase: 'L2',
            unitOfMeasure: { unit: 'W', multiplier: 3 },
          },
        ],
      },
    ]);
    expect(phases).toBe(4);
    expect(meterPowerKw([{ sampledValue: [{ value: 5, measurand: 'Voltage' }] }])).toBeNull();
    expect(meterPowerKw('not a list')).toBeNull();
  });

  it('names the BootNotification vendor and model in both versions', () => {
    expect(
      summarizeOcppMessage(
        call('BootNotification', {
          reason: 'PowerUp',
          chargingStation: { vendorName: 'EVtivity', model: 'DC-150' },
        }),
      ).parts,
    ).toEqual(['EVtivity', 'DC-150', 'PowerUp']);
    expect(
      summarizeOcppMessage(
        call('BootNotification', { chargePointVendor: 'Acme', chargePointModel: 'AC-22' }),
      ).parts,
    ).toEqual(['Acme', 'AC-22']);
  });

  it('dims Heartbeat calls and their results', () => {
    expect(summarizeOcppMessage(call('Heartbeat', {})).dim).toBe(true);
    expect(
      summarizeOcppMessage({
        action: 'Heartbeat',
        messageType: 3,
        payload: { currentTime: '2026-11-03T14:00:00Z' },
        errorCode: null,
        errorDescription: null,
      }).dim,
    ).toBe(true);
  });

  it('shows a CALLERROR code and a shortened description as an error', () => {
    const long = 'x'.repeat(ERROR_DESCRIPTION_MAX + 20);
    const s = summarizeOcppMessage({
      action: null,
      messageType: 4,
      payload: {},
      errorCode: 'FormatViolation',
      errorDescription: long,
    });
    expect(s.error).toBe(true);
    expect(s.parts[0]).toBe('FormatViolation');
    expect(s.parts[1]?.length).toBe(ERROR_DESCRIPTION_MAX);
  });

  it('shows a result status and marks a refusal', () => {
    const ok = summarizeOcppMessage({
      action: 'RequestStartTransaction',
      messageType: 3,
      payload: { status: 'Accepted' },
      errorCode: null,
      errorDescription: null,
    });
    expect(ok.parts).toEqual(['Accepted']);
    expect(ok.error).toBe(false);
    const blocked = summarizeOcppMessage({
      action: 'Authorize',
      messageType: 3,
      payload: { idTagInfo: { status: 'Blocked' } },
      errorCode: null,
      errorDescription: null,
    });
    expect(blocked.parts).toEqual(['Blocked']);
    expect(blocked.error).toBe(true);
  });

  it('falls back to a command type and survives odd payloads', () => {
    expect(summarizeOcppMessage(call('Reset', { type: 'OnIdle' })).parts).toEqual(['OnIdle']);
    expect(
      summarizeOcppMessage(call('TriggerMessage', { requestedMessage: 'Heartbeat' })).parts,
    ).toEqual(['Heartbeat']);
    expect(summarizeOcppMessage(call('TransactionEvent', null)).parts).toEqual([]);
    expect(summarizeOcppMessage(call('MeterValues', [1, 2])).powerKw).toBeNull();
  });
});
