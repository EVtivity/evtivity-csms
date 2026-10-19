// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The OCPP protocols (WebSocket subprotocol names) the CSMS speaks. Browser-safe. */
export const OCPP_PROTOCOLS = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const;
export type OcppProtocol = (typeof OCPP_PROTOCOLS)[number];

/**
 * OCPP 2.0.1 OCPPInterfaceEnumType, the network interface of a network
 * connection profile. OCPP 2.1 adds Any, which a 2.0.1 station refuses.
 */
export const OCPP201_NETWORK_INTERFACES = [
  'Wired0',
  'Wired1',
  'Wired2',
  'Wired3',
  'Wireless0',
  'Wireless1',
  'Wireless2',
  'Wireless3',
] as const;
export type Ocpp201NetworkInterface = (typeof OCPP201_NETWORK_INTERFACES)[number];

/** OCPP 2.0.1 and 2.1 share the 2.x message model (devices, EVSEs, TransactionEvent). */
export function isOcpp2x(protocol: string | null | undefined): protocol is 'ocpp2.0.1' | 'ocpp2.1' {
  return protocol === 'ocpp2.1' || protocol === 'ocpp2.0.1';
}

/** Features that exist only in OCPP 2.1 (local cost and tariffs, DER, V2X, battery swap, 2.1 payments). */
export function isOcpp21(protocol: string | null | undefined): protocol is 'ocpp2.1' {
  return protocol === 'ocpp2.1';
}

/**
 * The messages OCPP 2.1 defines and OCPP 2.0.1 does not, in both directions.
 * Every other 2.1 message exists in 2.0.1 too. The OCPP package tests this
 * list against the generated 2.1 and 2.0.1 registries.
 */
export const OCPP21_ONLY_ACTIONS: readonly string[] = [
  'AdjustPeriodicEventStream',
  'AFRRSignal',
  'BatterySwap',
  'ChangeTransactionTariff',
  'ClearDERControl',
  'ClearTariffs',
  'ClosePeriodicEventStream',
  'GetCertificateChainStatus',
  'GetDERControl',
  'GetPeriodicEventStream',
  'GetTariffs',
  'NotifyAllowedEnergyTransfer',
  'NotifyDERAlarm',
  'NotifyDERStartStop',
  'NotifyPriorityCharging',
  'NotifySettlement',
  'NotifyWebPaymentStarted',
  'OpenPeriodicEventStream',
  'PullDynamicScheduleUpdate',
  'ReportDERControl',
  'RequestBatterySwap',
  'SetDERControl',
  'SetDefaultTariff',
  'UpdateDynamicSchedule',
  'UsePriorityCharging',
  'VatNumberValidation',
];

const OCPP21_ONLY = new Set(OCPP21_ONLY_ACTIONS);

/** An OCPP message only 2.1 defines (`GetTariffs`, `SetDERControl`, ...). */
export function isOcpp21OnlyAction(action: string): boolean {
  return OCPP21_ONLY.has(action);
}

/**
 * SEND messages (message type 6, no reply) OCPP 2.1 adds. `OCPP21_ONLY_ACTIONS`
 * holds the CALL actions, which the generated registries list; a SEND message
 * has no request and response pair there.
 */
export const OCPP21_ONLY_SEND_MESSAGES: readonly string[] = ['NotifyPeriodicEventStream'];

const OCPP21_ONLY_SEND = new Set(OCPP21_ONLY_SEND_MESSAGES);

/** Any message only OCPP 2.1 defines: a 2.1-only CALL action or SEND message. */
export function isOcpp21OnlyMessage(action: string): boolean {
  return OCPP21_ONLY.has(action) || OCPP21_ONLY_SEND.has(action);
}

/** Variable monitor types OCPP 2.1 adds (SetVariableMonitoring). */
export const OCPP21_ONLY_MONITOR_TYPES: readonly string[] = ['TargetDelta', 'TargetDeltaRelative'];

/** Display message formats OCPP 2.1 adds (MessageFormatEnumType). */
export const OCPP21_ONLY_MESSAGE_FORMATS: readonly string[] = ['QRCODE'];

/** Display message states OCPP 2.1 adds (MessageStateEnumType). */
export const OCPP21_ONLY_MESSAGE_STATES: readonly string[] = ['Suspended', 'Discharging'];

/** Charging profile purposes OCPP 2.1 adds (ChargingProfilePurposeEnumType). */
export const OCPP21_ONLY_PROFILE_PURPOSES: readonly string[] = [
  'PriorityCharging',
  'LocalGeneration',
];

/** The longest message content OCPP 2.0.1 takes (2.1: 1024). */
export const OCPP201_MESSAGE_CONTENT_MAX_LENGTH = 512;

/**
 * The display message content a station of this protocol takes: cut to
 * `OCPP201_MESSAGE_CONTENT_MAX_LENGTH` characters (code points, as the schema
 * counts them, so no surrogate pair is split) for OCPP 2.0.1, unchanged for
 * other protocols. Store the hash of this value, so it matches what is sent.
 */
export function stationMessageContentFor(
  protocol: string | null | undefined,
  content: string,
): string {
  if (protocol !== 'ocpp2.0.1' || content.length <= OCPP201_MESSAGE_CONTENT_MAX_LENGTH) {
    return content;
  }
  const chars = Array.from(content);
  if (chars.length <= OCPP201_MESSAGE_CONTENT_MAX_LENGTH) return content;
  return chars.slice(0, OCPP201_MESSAGE_CONTENT_MAX_LENGTH).join('');
}

/** Whether a station of this protocol takes the OCPP 2.x action: 2.0.1 lacks the 2.1-only ones. */
export function ocpp2xActionFitsProtocol(
  action: string,
  protocol: string | null | undefined,
): boolean {
  return isOcpp21OnlyAction(action) ? isOcpp21(protocol) : isOcpp2x(protocol);
}
