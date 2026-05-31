// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface CommandTranslation {
  action: string;
  translatePayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  translateResponse: (response: Record<string, unknown>) => Record<string, unknown>;
}

const identity = (p: Record<string, unknown>): Record<string, unknown> => p;

function mapResetType(payload: Record<string, unknown>): Record<string, unknown> {
  const typeMap: Record<string, string> = {
    Immediate: 'Hard',
    OnIdle: 'Soft',
  };
  const incomingType = payload.type as string | undefined;
  const mapped = incomingType != null ? typeMap[incomingType] : undefined;
  if (mapped == null) {
    throw new Error(
      `Reset type "${String(incomingType)}" has no OCPP 1.6 equivalent. ` +
        `Only Immediate and OnIdle map to 1.6 Hard/Soft; ImmediateAndResume is 2.1-only.`,
    );
  }
  return { ...payload, type: mapped };
}

function mapAvailability16(payload: Record<string, unknown>): Record<string, unknown> {
  const evse = payload.evse as Record<string, unknown> | undefined;
  const connectorId = evse?.connectorId ?? 0;
  const typeMap: Record<string, string> = {
    Operative: 'Available',
    Inoperative: 'Unavailable',
  };
  return {
    connectorId,
    type: typeMap[payload.operationalStatus as string] ?? payload.operationalStatus,
  };
}

function mapStartTransaction16(payload: Record<string, unknown>): Record<string, unknown> {
  const idToken = payload.idToken as Record<string, unknown> | undefined;
  return {
    connectorId: payload.evseId ?? payload.connectorId ?? 1,
    idTag: idToken?.idToken ?? payload.idTag,
  };
}

function mapStopTransaction16(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.transactionId;
  const txId = Number(raw);
  // OCPP 1.6 spec: transactionId must be a positive integer assigned by the
  // station. Silently passing NaN downstream produces a malformed CALL the
  // station rejects with CALLERROR; surface it as a clear error here instead.
  if (!Number.isFinite(txId) || !Number.isInteger(txId) || txId <= 0) {
    throw new Error(`Invalid transactionId for OCPP 1.6 stop: ${String(raw)}`);
  }
  return { transactionId: txId };
}

function mapUnlockConnector16(payload: Record<string, unknown>): Record<string, unknown> {
  const evse = payload.evse as Record<string, unknown> | undefined;
  return {
    connectorId: evse?.connectorId ?? payload.connectorId ?? 1,
  };
}

function mapSetChargingProfile16(payload: Record<string, unknown>): Record<string, unknown> {
  const { evseId, ...rest } = payload;
  return { ...rest, connectorId: evseId };
}

function mapClearChargingProfile16(payload: Record<string, unknown>): Record<string, unknown> {
  // OCPP 2.1 nests filter fields under `chargingProfileCriteria` and uses
  // `chargingProfileId` for the per-profile id. OCPP 1.6 has all fields at the
  // top level, calls the id field `id`, and uses `connectorId` instead of
  // `evseId`. The 1.6 schema is `additionalProperties: false`, so any 2.1
  // field name leaking through becomes a FormationViolation.
  const { chargingProfileId, chargingProfileCriteria, ...rest } = payload;
  const criteria = (chargingProfileCriteria as Record<string, unknown> | undefined) ?? rest;
  const { evseId, customData: _customData, ...flat } = criteria;
  void _customData;
  const result: Record<string, unknown> = { ...flat };
  if (chargingProfileId != null) result.id = chargingProfileId;
  if (evseId != null) result.connectorId = evseId;
  return result;
}

function mapGetCompositeSchedule16(payload: Record<string, unknown>): Record<string, unknown> {
  const evseId = payload.evseId;
  return { ...payload, connectorId: evseId };
}

function mapReserveNow16(payload: Record<string, unknown>): Record<string, unknown> {
  const idToken = payload.idToken as Record<string, unknown> | undefined;
  const evseId = payload.evseId;
  return {
    connectorId: evseId ?? 0,
    expiryDate: payload.expiryDateTime ?? payload.expiryDate,
    idTag: idToken?.idToken ?? payload.idTag,
    reservationId: payload.id ?? payload.reservationId,
  };
}

function mapSendLocalList16(payload: Record<string, unknown>): Record<string, unknown> {
  const list = payload.localAuthorizationList as Record<string, unknown>[] | undefined;
  if (list == null) return payload;
  return {
    ...payload,
    localAuthorizationList: list.map((entry) => {
      const idToken = entry.idToken as Record<string, unknown> | undefined;
      return {
        ...entry,
        idTag: idToken?.idToken ?? entry.idTag,
      };
    }),
  };
}

function mapGetVariables16(payload: Record<string, unknown>): Record<string, unknown> {
  const variables = payload.getVariableData as Record<string, unknown>[] | undefined;
  if (variables == null || variables.length === 0) return {};
  // OCPP 1.6 GetConfiguration accepts a `key` array but the response is a
  // single map; mapping multiple 2.1 variables onto one 1.6 call would lose
  // the per-variable status the 2.1 schema returns. Force callers to loop
  // explicitly for 1.6 stations (config-push already does this) instead of
  // silently dropping all but the first variable.
  if (variables.length > 1) {
    throw new Error(
      `GetVariables to an OCPP 1.6 station must contain at most one variable per call; ` +
        `received ${String(variables.length)}. The caller must split the request and send one ` +
        `ChangeConfiguration / GetConfiguration per variable.`,
    );
  }
  const first = variables[0];
  if (first == null) return {};
  const component = first.component as Record<string, unknown> | undefined;
  const variable = first.variable as Record<string, unknown> | undefined;
  return {
    key: [component?.name ?? variable?.name].filter(Boolean),
  };
}

function mapSetVariables16(payload: Record<string, unknown>): Record<string, unknown> {
  const variables = payload.setVariableData as Record<string, unknown>[] | undefined;
  if (variables == null || variables.length === 0) return {};
  // OCPP 1.6 ChangeConfiguration accepts a single `key`/`value` pair. Mapping
  // multiple 2.1 setVariableData entries onto one 1.6 call would silently
  // apply only the first and drop the rest. Throwing here surfaces the
  // mismatch so callers can loop.
  if (variables.length > 1) {
    throw new Error(
      `SetVariables to an OCPP 1.6 station must contain at most one variable per call; ` +
        `received ${String(variables.length)}. The caller must split the request and send one ` +
        `ChangeConfiguration per variable.`,
    );
  }
  const first = variables[0];
  if (first == null) return {};
  const component = first.component as Record<string, unknown> | undefined;
  const variable = first.variable as Record<string, unknown> | undefined;
  return {
    key: component?.name ?? variable?.name,
    value: first.attributeValue,
  };
}

function mapUpdateFirmware16(payload: Record<string, unknown>): Record<string, unknown> {
  const firmware = payload.firmware as Record<string, unknown> | undefined;
  return {
    location: firmware?.location ?? payload.location,
    retrieveDate: firmware?.retrieveDateTime ?? payload.retrieveDate,
    retries: payload.retries,
    retryInterval: payload.retryInterval,
  };
}

function mapGetLog16(payload: Record<string, unknown>): Record<string, unknown> {
  const log = payload.log as Record<string, unknown> | undefined;
  return {
    location: log?.remoteLocation ?? payload.location,
    startTime: log?.oldestTimestamp,
    stopTime: log?.latestTimestamp,
    retries: payload.retries,
    retryInterval: payload.retryInterval,
  };
}

const commandMap: Record<string, Record<string, CommandTranslation>> = {
  RequestStartTransaction: {
    'ocpp2.1': {
      action: 'RequestStartTransaction',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'RemoteStartTransaction',
      translatePayload: mapStartTransaction16,
      translateResponse: identity,
    },
  },
  RequestStopTransaction: {
    'ocpp2.1': {
      action: 'RequestStopTransaction',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'RemoteStopTransaction',
      translatePayload: mapStopTransaction16,
      translateResponse: identity,
    },
  },
  Reset: {
    'ocpp2.1': { action: 'Reset', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': { action: 'Reset', translatePayload: mapResetType, translateResponse: identity },
  },
  ChangeAvailability: {
    'ocpp2.1': {
      action: 'ChangeAvailability',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'ChangeAvailability',
      translatePayload: mapAvailability16,
      translateResponse: identity,
    },
  },
  UnlockConnector: {
    'ocpp2.1': {
      action: 'UnlockConnector',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'UnlockConnector',
      translatePayload: mapUnlockConnector16,
      translateResponse: identity,
    },
  },
  TriggerMessage: {
    'ocpp2.1': {
      action: 'TriggerMessage',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'TriggerMessage',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  GetLocalListVersion: {
    'ocpp2.1': {
      action: 'GetLocalListVersion',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'GetLocalListVersion',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  SendLocalList: {
    'ocpp2.1': { action: 'SendLocalList', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': {
      action: 'SendLocalList',
      translatePayload: mapSendLocalList16,
      translateResponse: identity,
    },
  },
  SetChargingProfile: {
    'ocpp2.1': {
      action: 'SetChargingProfile',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'SetChargingProfile',
      translatePayload: mapSetChargingProfile16,
      translateResponse: identity,
    },
  },
  ClearChargingProfile: {
    'ocpp2.1': {
      action: 'ClearChargingProfile',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'ClearChargingProfile',
      translatePayload: mapClearChargingProfile16,
      translateResponse: identity,
    },
  },
  GetChargingProfiles: {
    'ocpp2.1': {
      action: 'GetChargingProfiles',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'NotSupported',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  GetCompositeSchedule: {
    'ocpp2.1': {
      action: 'GetCompositeSchedule',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'GetCompositeSchedule',
      translatePayload: mapGetCompositeSchedule16,
      translateResponse: identity,
    },
  },
  ClearCache: {
    'ocpp2.1': { action: 'ClearCache', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': { action: 'ClearCache', translatePayload: identity, translateResponse: identity },
  },
  UpdateFirmware: {
    'ocpp2.1': {
      action: 'UpdateFirmware',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'UpdateFirmware',
      translatePayload: mapUpdateFirmware16,
      translateResponse: identity,
    },
  },
  ReserveNow: {
    'ocpp2.1': { action: 'ReserveNow', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': {
      action: 'ReserveNow',
      translatePayload: mapReserveNow16,
      translateResponse: identity,
    },
  },
  CancelReservation: {
    'ocpp2.1': {
      action: 'CancelReservation',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'CancelReservation',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  DataTransfer: {
    'ocpp2.1': { action: 'DataTransfer', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': { action: 'DataTransfer', translatePayload: identity, translateResponse: identity },
  },
  GetVariables: {
    'ocpp2.1': { action: 'GetVariables', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': {
      action: 'GetConfiguration',
      translatePayload: mapGetVariables16,
      translateResponse: identity,
    },
  },
  SetVariables: {
    'ocpp2.1': { action: 'SetVariables', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': {
      action: 'ChangeConfiguration',
      translatePayload: mapSetVariables16,
      translateResponse: identity,
    },
  },
  GetLog: {
    'ocpp2.1': { action: 'GetLog', translatePayload: identity, translateResponse: identity },
    'ocpp1.6': {
      action: 'GetDiagnostics',
      translatePayload: mapGetLog16,
      translateResponse: identity,
    },
  },
  CertificateSigned: {
    'ocpp2.1': {
      action: 'CertificateSigned',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'CertificateSigned',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  InstallCertificate: {
    'ocpp2.1': {
      action: 'InstallCertificate',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'InstallCertificate',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  DeleteCertificate: {
    'ocpp2.1': {
      action: 'DeleteCertificate',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'DeleteCertificate',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  GetInstalledCertificateIds: {
    'ocpp2.1': {
      action: 'GetInstalledCertificateIds',
      translatePayload: identity,
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'GetInstalledCertificateIds',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  ExtendedTriggerMessage: {
    'ocpp1.6': {
      action: 'ExtendedTriggerMessage',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
  SignedUpdateFirmware: {
    'ocpp1.6': {
      action: 'SignedUpdateFirmware',
      translatePayload: identity,
      translateResponse: identity,
    },
  },
};

export function translateCommand(
  commandName: string,
  version: string,
  payload: Record<string, unknown>,
): { action: string; payload: Record<string, unknown> } | null {
  const translations = commandMap[commandName];
  if (translations == null) {
    // No translation entry: only supported in the version that defines it
    if (version === 'ocpp2.1') {
      return { action: commandName, payload };
    }
    return null;
  }

  const translation = translations[version];
  if (translation == null) {
    return null;
  }

  return {
    action: translation.action,
    payload: translation.translatePayload(payload),
  };
}

export function translateResponse(
  commandName: string,
  version: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const translation = commandMap[commandName]?.[version];
  if (translation == null) return response;
  return translation.translateResponse(response);
}
