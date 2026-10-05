// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppVersion } from './types.js';

/**
 * The test station's answer to a CSMS call the test does not check: a
 * schema-valid response for the action, so the CSMS does not log a failed
 * response validation for every command it sends a test station on its own
 * (station messages, configuration pushes, payment stops). The values decline
 * or accept without side effects. An action without an entry gets the CALLERROR
 * NotImplemented, which OCPP allows for any action.
 *
 * Test incoming call handlers fall back to it: `return defaultReply(version, action, payload)`.
 */
export function defaultReply(
  version: OcppVersion,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = (version === 'ocpp1.6' ? REPLIES_16 : REPLIES_21)[action]?.(payload);
  // OcppClient sends an Error whose message is an OCPP error code as that CALLERROR.
  return reply != null ? Promise.resolve(reply) : Promise.reject(new Error('NotImplemented'));
}

type Reply = (payload: Record<string, unknown>) => Record<string, unknown>;

function items(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(payload[key]) ? (payload[key] as Record<string, unknown>[]) : [];
}

const status =
  (value: string): Reply =>
  () => ({ status: value });

const REPLIES_21: Record<string, Reply> = {
  // One result per request item, echoing its component and variable.
  SetVariables: (payload) => ({
    setVariableResult: items(payload, 'setVariableData').map((item) => ({
      ...(item['attributeType'] != null ? { attributeType: item['attributeType'] } : {}),
      attributeStatus: 'Accepted',
      component: item['component'],
      variable: item['variable'],
    })),
  }),
  GetVariables: (payload) => ({
    getVariableResult: items(payload, 'getVariableData').map((item) => ({
      ...(item['attributeType'] != null ? { attributeType: item['attributeType'] } : {}),
      attributeStatus: 'UnknownComponent',
      component: item['component'],
      variable: item['variable'],
    })),
  }),
  ClearVariableMonitoring: (payload) => ({
    clearMonitoringResult: (Array.isArray(payload['id']) ? payload['id'] : []).map(
      (id: unknown) => ({ id, status: 'Accepted' }),
    ),
  }),
  SetMonitoringBase: status('Accepted'),
  SetMonitoringLevel: status('Accepted'),
  SetNetworkProfile: status('Accepted'),
  GetBaseReport: status('NotSupported'),
  GetReport: status('NotSupported'),
  GetMonitoringReport: status('NotSupported'),
  RequestStartTransaction: status('Rejected'),
  RequestStopTransaction: status('Accepted'),
  GetTransactionStatus: () => ({ messagesInQueue: false }),
  CostUpdated: () => ({}),
  NotifyWebPaymentStarted: () => ({}),
  SetDisplayMessage: status('Accepted'),
  ClearDisplayMessage: status('Accepted'),
  GetDisplayMessages: status('Unknown'),
  TriggerMessage: status('NotImplemented'),
  DataTransfer: status('UnknownVendorId'),
  SetChargingProfile: status('Rejected'),
  ClearChargingProfile: status('Unknown'),
  GetChargingProfiles: status('NoProfiles'),
  GetCompositeSchedule: status('Rejected'),
  SetDefaultTariff: status('Rejected'),
  GetTariffs: status('NoTariff'),
  ChangeTransactionTariff: status('Rejected'),
  ChangeAvailability: status('Accepted'),
  Reset: status('Rejected'),
  UnlockConnector: status('UnlockFailed'),
  ClearCache: status('Rejected'),
  SendLocalList: status('Failed'),
  GetLocalListVersion: () => ({ versionNumber: 0 }),
  ReserveNow: status('Rejected'),
  CancelReservation: status('Rejected'),
  UpdateFirmware: status('Rejected'),
  GetLog: status('Rejected'),
  CustomerInformation: status('Rejected'),
  CertificateSigned: status('Rejected'),
  InstallCertificate: status('Rejected'),
  DeleteCertificate: status('NotFound'),
  GetInstalledCertificateIds: status('NotFound'),
};

const REPLIES_16: Record<string, Reply> = {
  ChangeConfiguration: status('Accepted'),
  // Every requested key is unknown; no keys requested means none reported.
  GetConfiguration: (payload) => ({
    configurationKey: [],
    unknownKey: Array.isArray(payload['key']) ? payload['key'] : [],
  }),
  RemoteStartTransaction: status('Rejected'),
  RemoteStopTransaction: status('Accepted'),
  TriggerMessage: status('NotImplemented'),
  ExtendedTriggerMessage: status('NotImplemented'),
  DataTransfer: status('UnknownVendorId'),
  SetChargingProfile: status('Rejected'),
  ClearChargingProfile: status('Unknown'),
  GetCompositeSchedule: status('Rejected'),
  ChangeAvailability: status('Accepted'),
  Reset: status('Rejected'),
  UnlockConnector: status('NotSupported'),
  ClearCache: status('Rejected'),
  SendLocalList: status('NotSupported'),
  GetLocalListVersion: () => ({ listVersion: -1 }),
  ReserveNow: status('Rejected'),
  CancelReservation: status('Rejected'),
  UpdateFirmware: () => ({}),
  GetDiagnostics: () => ({}),
  SignedUpdateFirmware: status('Rejected'),
  GetLog: status('Rejected'),
  CertificateSigned: status('Rejected'),
  InstallCertificate: status('Rejected'),
  DeleteCertificate: status('NotFound'),
  GetInstalledCertificateIds: status('NotFound'),
};

/** Actions with a default reply, per version (for tests of this module). */
export const DEFAULT_REPLY_ACTIONS: Record<OcppVersion, string[]> = {
  'ocpp1.6': Object.keys(REPLIES_16),
  'ocpp2.1': Object.keys(REPLIES_21),
};
