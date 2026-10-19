// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  STOP_REASONS_16,
  STOP_REASONS_201,
  STOP_REASONS_21,
  endedTriggerFor2x,
  faultStopReason,
  isStopReasonFor,
} from '../lib/stop-reasons.js';

function schema(path: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../../../schemas/${path}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

describe('stop reasons', () => {
  it('match the OCPP schemas', () => {
    const s16 = schema('ocpp-1.6/StopTransaction.json') as {
      properties: { reason: { enum: string[] } };
    };
    expect([...STOP_REASONS_16].sort()).toEqual([...s16.properties.reason.enum].sort());
    const s21 = schema('ocpp-2.1/TransactionEventRequest.json') as {
      definitions: { ReasonEnumType: { enum: string[] } };
    };
    expect([...STOP_REASONS_21].sort()).toEqual([...s21.definitions.ReasonEnumType.enum].sort());
    const s201 = schema('ocpp-2.0.1/TransactionEventRequest.json') as {
      definitions: { ReasonEnumType: { enum: string[] } };
    };
    expect([...STOP_REASONS_201].sort()).toEqual([...s201.definitions.ReasonEnumType.enum].sort());
  });

  it('checks a reason per version', () => {
    expect(isStopReasonFor('ocpp1.6', 'HardReset')).toBe(true);
    expect(isStopReasonFor('ocpp1.6', 'SOCLimitReached')).toBe(false);
    expect(isStopReasonFor('ocpp2.1', 'SOCLimitReached')).toBe(true);
    expect(isStopReasonFor('ocpp2.1', 'EVDeparted')).toBe(false);
    expect(isStopReasonFor('ocpp2.0.1', 'SOCLimitReached')).toBe(true);
    expect(isStopReasonFor('ocpp2.1', 'ReqEnergyTransferRejected')).toBe(true);
    expect(isStopReasonFor('ocpp2.0.1', 'ReqEnergyTransferRejected')).toBe(false);
  });

  it('maps every 2.1 reason to a TriggerReasonEnumType value', () => {
    const triggers = (
      schema('ocpp-2.1/TransactionEventRequest.json') as {
        definitions: { TriggerReasonEnumType: { enum: string[] } };
      }
    ).definitions.TriggerReasonEnumType.enum;
    for (const reason of STOP_REASONS_21) {
      expect(triggers).toContain(endedTriggerFor2x('ocpp2.1', reason).triggerReason);
    }
    expect(endedTriggerFor2x('ocpp2.1', 'EVDisconnected')).toEqual({
      triggerReason: 'EVCommunicationLost',
      chargingState: 'Idle',
    });
    expect(endedTriggerFor2x('ocpp2.1', 'GroundFault').triggerReason).toBe('AbnormalCondition');
  });

  it('maps every 2.0.1 reason to a 2.0.1 TriggerReasonEnumType value', () => {
    const triggers = (
      schema('ocpp-2.0.1/TransactionEventRequest.json') as {
        definitions: { TriggerReasonEnumType: { enum: string[] } };
      }
    ).definitions.TriggerReasonEnumType.enum;
    for (const reason of STOP_REASONS_201) {
      expect(triggers).toContain(endedTriggerFor2x('ocpp2.0.1', reason).triggerReason);
    }
    expect(endedTriggerFor2x('ocpp2.0.1', 'SOCLimitReached').triggerReason).toBe(
      'EnergyLimitReached',
    );
    expect(endedTriggerFor2x('ocpp2.0.1', 'LocalOutOfCredit').triggerReason).toBe(
      'EnergyLimitReached',
    );
    expect(endedTriggerFor2x('ocpp2.0.1', 'Remote').triggerReason).toBe('RemoteStop');
  });

  it('maps faults to stop reasons', () => {
    expect(faultStopReason('ocpp2.1', 'GroundFailure')).toBe('GroundFault');
    expect(faultStopReason('ocpp2.1', 'OverCurrentFailure')).toBe('OvercurrentFault');
    expect(faultStopReason('ocpp2.1', 'HighTemperature')).toBe('Other');
    expect(faultStopReason('ocpp1.6', 'GroundFailure')).toBe('Other');
    expect(faultStopReason('ocpp2.0.1', 'GroundFailure')).toBe('GroundFault');
  });
});
