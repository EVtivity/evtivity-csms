// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  STOP_REASONS_16,
  STOP_REASONS_21,
  endedTriggerFor21,
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
  });

  it('checks a reason per version', () => {
    expect(isStopReasonFor('ocpp1.6', 'HardReset')).toBe(true);
    expect(isStopReasonFor('ocpp1.6', 'SOCLimitReached')).toBe(false);
    expect(isStopReasonFor('ocpp2.1', 'SOCLimitReached')).toBe(true);
    expect(isStopReasonFor('ocpp2.1', 'EVDeparted')).toBe(false);
  });

  it('maps every 2.1 reason to a TriggerReasonEnumType value', () => {
    const triggers = (
      schema('ocpp-2.1/TransactionEventRequest.json') as {
        definitions: { TriggerReasonEnumType: { enum: string[] } };
      }
    ).definitions.TriggerReasonEnumType.enum;
    for (const reason of STOP_REASONS_21) {
      expect(triggers).toContain(endedTriggerFor21(reason).triggerReason);
    }
    expect(endedTriggerFor21('EVDisconnected')).toEqual({
      triggerReason: 'EVCommunicationLost',
      chargingState: 'Idle',
    });
    expect(endedTriggerFor21('GroundFault').triggerReason).toBe('AbnormalCondition');
  });

  it('maps faults to stop reasons', () => {
    expect(faultStopReason('ocpp2.1', 'GroundFailure')).toBe('GroundFault');
    expect(faultStopReason('ocpp2.1', 'OverCurrentFailure')).toBe('OvercurrentFault');
    expect(faultStopReason('ocpp2.1', 'HighTemperature')).toBe('Other');
    expect(faultStopReason('ocpp1.6', 'GroundFailure')).toBe('Other');
  });
});
