// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Stop reasons per OCPP version, taken from the schemas:
// - 1.6: StopTransaction.json `reason`
// - 2.1: TransactionEventRequest.json `ReasonEnumType`
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

export type StopReason16 = (typeof STOP_REASONS_16)[number];
export type StopReason21 = (typeof STOP_REASONS_21)[number];

export type OcppProtocol = 'ocpp1.6' | 'ocpp2.1';

/** True when the reason is in the stop reason set of the protocol. */
export function isStopReasonFor(protocol: OcppProtocol, reason: string): boolean {
  const reasons: readonly string[] = protocol === 'ocpp1.6' ? STOP_REASONS_16 : STOP_REASONS_21;
  return reasons.includes(reason);
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
 * OCPP 2.1 TransactionEvent Ended: the triggerReason and the chargingState the station
 * reports for a stop reason. Reasons without a specific trigger end with StopAuthorized.
 */
export function endedTriggerFor21(reason: string): {
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
