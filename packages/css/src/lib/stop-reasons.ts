// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppProtocol } from '@evtivity/lib/ocpp-version';
import { TRIGGER_REASONS_TO_201 } from './ocpp201.js';

// Stop reasons per OCPP version, taken from the schemas:
// - 1.6: StopTransaction.json `reason`
// - 2.0.1 and 2.1: TransactionEventRequest.json `ReasonEnumType`
export const STOP_REASONS_16 = [
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
] as const;

export const STOP_REASONS_21 = [
  'DeAuthorized',
  'EmergencyStop',
  'EnergyLimitReached',
  'EVDisconnected',
  'GroundFault',
  'ImmediateReset',
  'MasterPass',
  'Local',
  'LocalOutOfCredit',
  'Other',
  'OvercurrentFault',
  'PowerLoss',
  'PowerQuality',
  'Reboot',
  'Remote',
  'SOCLimitReached',
  'StoppedByEV',
  'TimeLimitReached',
  'Timeout',
  'ReqEnergyTransferRejected',
] as const;

/** 2.1 adds ReqEnergyTransferRejected. */
export const STOP_REASONS_201 = STOP_REASONS_21.filter((r) => r !== 'ReqEnergyTransferRejected');

export type StopReason16 = (typeof STOP_REASONS_16)[number];
export type StopReason21 = (typeof STOP_REASONS_21)[number];

function stopReasonsOf(protocol: OcppProtocol): readonly string[] {
  if (protocol === 'ocpp1.6') return STOP_REASONS_16;
  if (protocol === 'ocpp2.0.1') return STOP_REASONS_201;
  return STOP_REASONS_21;
}

/** True when the reason is in the stop reason set of the protocol. */
export function isStopReasonFor(protocol: OcppProtocol, reason: string): boolean {
  return stopReasonsOf(protocol).includes(reason);
}

// Stop reasons that report a station fault (2.1 triggerReason AbnormalCondition).
const ABNORMAL_STOP_REASONS_21: ReadonlySet<string> = new Set([
  'EmergencyStop',
  'GroundFault',
  'OvercurrentFault',
  'Other',
  'PowerLoss',
  'PowerQuality',
]);

/**
 * OCPP 2.x TransactionEvent Ended: the triggerReason and the chargingState the station
 * reports for a stop reason. Reasons without a specific trigger end with StopAuthorized.
 * 2.0.1 lacks SoCLimitReached and CostLimitReached and reports EnergyLimitReached.
 */
export function endedTriggerFor2x(
  protocol: OcppProtocol,
  reason: string,
): { triggerReason: string; chargingState: string } {
  const ended = endedTriggerFor21(reason);
  if (protocol === 'ocpp2.0.1') {
    return {
      ...ended,
      triggerReason: TRIGGER_REASONS_TO_201[ended.triggerReason] ?? ended.triggerReason,
    };
  }
  return ended;
}

function endedTriggerFor21(reason: string): {
  triggerReason: string;
  chargingState: string;
} {
  switch (reason) {
    case 'Remote':
      return { triggerReason: 'RemoteStop', chargingState: 'EVConnected' };
    case 'EVDisconnected':
      return { triggerReason: 'EVCommunicationLost', chargingState: 'Idle' };
    case 'DeAuthorized':
      return { triggerReason: 'Deauthorized', chargingState: 'EVConnected' };
    case 'StoppedByEV':
      return { triggerReason: 'ChargingStateChanged', chargingState: 'EVConnected' };
    case 'SOCLimitReached':
      return { triggerReason: 'SoCLimitReached', chargingState: 'EVConnected' };
    case 'EnergyLimitReached':
      return { triggerReason: 'EnergyLimitReached', chargingState: 'EVConnected' };
    case 'TimeLimitReached':
      return { triggerReason: 'TimeLimitReached', chargingState: 'EVConnected' };
    case 'LocalOutOfCredit':
      return { triggerReason: 'CostLimitReached', chargingState: 'EVConnected' };
    default:
      return {
        triggerReason: ABNORMAL_STOP_REASONS_21.has(reason)
          ? 'AbnormalCondition'
          : 'StopAuthorized',
        chargingState: 'EVConnected',
      };
  }
}

/**
 * The stop reason of a transaction a connector fault ends. 2.1 names ground and
 * overcurrent faults; every other fault is Other. 1.6 has no fault reasons
 * (EmergencyStop is the stop button), so every fault ends with Other.
 */
export function faultStopReason(protocol: OcppProtocol, errorCode: string): string {
  if (protocol === 'ocpp1.6') return 'Other';
  if (errorCode === 'GroundFailure') return 'GroundFault';
  if (errorCode === 'OverCurrentFailure') return 'OvercurrentFault';
  return 'Other';
}
