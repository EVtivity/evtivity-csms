// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { toAuthorizationKeyHex, unwrapPnc16Answer, wrapPnc16 } from '@evtivity/lib';

export interface CommandTranslation {
  action: string;
  /** Picks the action from the 2.1 payload when one command maps to two (default `action`). */
  resolveAction?: (payload: Record<string, unknown>) => string;
  translatePayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  /** Maps the station's response back to the 2.1 shape; `request` is the 2.1 payload sent. */
  translateResponse: (
    response: Record<string, unknown>,
    request: Record<string, unknown>,
  ) => Record<string, unknown>;
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

/**
 * 2.1 ChangeAvailability `{ evse?: { id }, operationalStatus }` to 1.6
 * `{ connectorId, type }`. Both versions name the status Operative or
 * Inoperative. A 1.6 connector is the 2.1 EVSE (`evse.id`); no EVSE means the
 * whole station, connectorId 0.
 */
function mapAvailability16(payload: Record<string, unknown>): Record<string, unknown> {
  const evse = payload.evse as Record<string, unknown> | undefined;
  return {
    connectorId: evse?.id ?? 0,
    type: payload.operationalStatus,
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

// A 1.6 connectorId numbers what 2.1 calls the EVSE (a 1.6 station's
// connector N is EVSE N with connector 1), so the 2.1 evseId is the 1.6
// connectorId; the 2.1 connectorId (the connector within the EVSE) is used
// only when no evseId is given.
function mapUnlockConnector16(payload: Record<string, unknown>): Record<string, unknown> {
  const evse = payload.evse as Record<string, unknown> | undefined;
  return {
    connectorId: payload.evseId ?? evse?.id ?? evse?.connectorId ?? payload.connectorId ?? 1,
  };
}

// OCPP 2.1 profile purposes and their 1.6 names. A CSMS never sends
// ChargingStationExternalConstraints (2.1 K01.FR.22, K10.FR.06), and
// PriorityCharging and LocalGeneration have no 1.6 form.
const PROFILE_PURPOSE_16: Record<string, string> = {
  ChargingStationMaxProfile: 'ChargePointMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
};

function profilePurpose16(purpose: unknown): string {
  const mapped = typeof purpose === 'string' ? PROFILE_PURPOSE_16[purpose] : undefined;
  if (mapped == null) {
    throw new Error(
      `Charging profile purpose "${String(purpose)}" is not supported on ocpp1.6 stations`,
    );
  }
  return mapped;
}

// 1.6 limits and minChargingRate are multiples of 0.1.
function tenth(value: unknown): unknown {
  return typeof value === 'number' ? Math.round(value * 10) / 10 : value;
}

function withoutUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * 2.1 `{ evseId, chargingProfile }` to 1.6 `{ connectorId, csChargingProfiles }`.
 * The 1.6 profile names its id `chargingProfileId`, holds one schedule object
 * (2.1 sends an array) and a numeric transactionId. The 1.6 schema is
 * `additionalProperties: false` throughout, so only its fields are copied.
 */
function mapSetChargingProfile16(payload: Record<string, unknown>): Record<string, unknown> {
  const profile = payload.chargingProfile as Record<string, unknown> | undefined;
  if (profile == null) {
    throw new Error('SetChargingProfile has no chargingProfile');
  }
  if (profile.chargingProfileKind === 'Dynamic') {
    throw new Error('Charging profile kind "Dynamic" is not supported on ocpp1.6 stations');
  }
  const schedules = profile.chargingSchedule;
  const schedule = (Array.isArray(schedules) ? schedules[0] : schedules) as
    | Record<string, unknown>
    | undefined;
  if (schedule == null) {
    throw new Error('SetChargingProfile has no charging schedule');
  }
  if (Array.isArray(schedules) && schedules.length > 1) {
    throw new Error('OCPP 1.6 stations take exactly one charging schedule');
  }
  let transactionId: number | undefined;
  const rawTransactionId = profile.transactionId;
  if (rawTransactionId != null) {
    transactionId =
      typeof rawTransactionId === 'number'
        ? rawTransactionId
        : typeof rawTransactionId === 'string' && /^-?\d+$/.test(rawTransactionId)
          ? Number(rawTransactionId)
          : NaN;
    if (!Number.isInteger(transactionId)) {
      throw new Error(
        `Invalid transactionId for an OCPP 1.6 charging profile: ${JSON.stringify(rawTransactionId)}`,
      );
    }
  }
  const periods = (schedule.chargingSchedulePeriod as Record<string, unknown>[] | undefined) ?? [];
  return {
    connectorId: payload.evseId ?? 0,
    csChargingProfiles: withoutUndefined({
      chargingProfileId: profile.id,
      transactionId,
      stackLevel: profile.stackLevel,
      chargingProfilePurpose: profilePurpose16(profile.chargingProfilePurpose),
      chargingProfileKind: profile.chargingProfileKind,
      recurrencyKind: profile.recurrencyKind,
      validFrom: profile.validFrom,
      validTo: profile.validTo,
      chargingSchedule: withoutUndefined({
        duration: schedule.duration,
        startSchedule: schedule.startSchedule,
        chargingRateUnit: schedule.chargingRateUnit,
        chargingSchedulePeriod: periods.map((period) =>
          withoutUndefined({
            startPeriod: period.startPeriod,
            limit: tenth(period.limit),
            numberPhases: period.numberPhases,
          }),
        ),
        minChargingRate: tenth(schedule.minChargingRate),
      }),
    }),
  };
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
  if (flat.chargingProfilePurpose != null) {
    result.chargingProfilePurpose = profilePurpose16(flat.chargingProfilePurpose);
  }
  if (chargingProfileId != null) result.id = chargingProfileId;
  if (evseId != null) result.connectorId = evseId;
  return result;
}

function mapGetCompositeSchedule16(payload: Record<string, unknown>): Record<string, unknown> {
  // The 1.6 schema is `additionalProperties: false`; keep only its fields.
  const { evseId, customData: _customData, ...rest } = payload;
  void _customData;
  return { ...rest, connectorId: evseId ?? 0 };
}

/**
 * 1.6 `{ status, connectorId, scheduleStart, chargingSchedule }` back to the 2.1
 * `{ status, schedule: { evseId, duration, scheduleStart, chargingRateUnit,
 * chargingSchedulePeriod } }`, so callers read one shape for both versions.
 */
function mapGetCompositeScheduleResponse16(
  response: Record<string, unknown>,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const chargingSchedule = response.chargingSchedule as Record<string, unknown> | undefined;
  if (chargingSchedule == null) return { status: response.status };
  return {
    status: response.status,
    schedule: withoutUndefined({
      evseId: response.connectorId ?? request.evseId ?? 0,
      duration: chargingSchedule.duration ?? request.duration,
      scheduleStart: response.scheduleStart ?? chargingSchedule.startSchedule,
      chargingRateUnit: chargingSchedule.chargingRateUnit,
      chargingSchedulePeriod: chargingSchedule.chargingSchedulePeriod ?? [],
    }),
  };
}

// A 1.6 configuration key is the 2.1 variable name (HeartbeatInterval), not the
// component (OCPPCommCtrlr). Templates for 1.6 store an empty component name.
function configKey16(entry: Record<string, unknown>): string | undefined {
  const component = entry.component as Record<string, unknown> | undefined;
  const variable = entry.variable as Record<string, unknown> | undefined;
  const name = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  return name(variable?.name) ?? name(component?.name);
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

// OCPP 1.6 AuthorizationStatus has no NoCredit (2.1 only): a prepaid card
// without credit is Blocked, as the 1.6 Authorize answers it.
const AUTHORIZATION_STATUS_16 = new Set([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);

function authorizationStatus16(status: unknown): string {
  if (typeof status === 'string' && AUTHORIZATION_STATUS_16.has(status)) return status;
  return status === 'Unknown' ? 'Invalid' : 'Blocked';
}

/**
 * 2.1 SendLocalListRequest to the 1.6 shape (SendLocalList.json): versionNumber
 * becomes listVersion, each entry { idToken, idTokenInfo } becomes { idTag,
 * idTagInfo { status, expiryDate, parentIdTag } }. The 1.6 schema allows no
 * other property, and an entry without idTagInfo would carry no status. An
 * entry already in 1.6 shape passes through.
 */
function mapSendLocalList16(payload: Record<string, unknown>): Record<string, unknown> {
  const listVersion = payload.listVersion ?? payload.versionNumber;
  const result: Record<string, unknown> = { listVersion, updateType: payload.updateType };
  const list = payload.localAuthorizationList as Record<string, unknown>[] | undefined;
  if (list == null) return result;
  result.localAuthorizationList = list.map((entry) => {
    const idToken = entry.idToken as Record<string, unknown> | undefined;
    const mapped: Record<string, unknown> = { idTag: idToken?.idToken ?? entry.idTag };
    if (entry.idTagInfo != null) {
      mapped.idTagInfo = entry.idTagInfo;
      return mapped;
    }
    const info = entry.idTokenInfo as Record<string, unknown> | undefined;
    if (info == null) return mapped;
    const idTagInfo: Record<string, unknown> = { status: authorizationStatus16(info.status) };
    if (info.cacheExpiryDateTime != null) idTagInfo.expiryDate = info.cacheExpiryDateTime;
    const group = info.groupIdToken as Record<string, unknown> | undefined;
    if (group?.idToken != null) idTagInfo.parentIdTag = group.idToken;
    mapped.idTagInfo = idTagInfo;
    return mapped;
  });
  return result;
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
  return {
    key: [configKey16(first)].filter(Boolean),
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
  // OCPP 1.6 sets the Basic Auth password as AuthorizationKey, hex-encoded
  // (Security Whitepaper; OCTT TC_073).
  if (
    (first.component as Record<string, unknown> | undefined)?.name === 'SecurityCtrlr' &&
    (first.variable as Record<string, unknown> | undefined)?.name === 'BasicAuthPassword'
  ) {
    return { key: 'AuthorizationKey', value: toAuthorizationKeyHex(String(first.attributeValue)) };
  }
  return {
    key: configKey16(first),
    value: first.attributeValue,
  };
}

/**
 * A firmware update that carries a signing certificate and a signature goes
 * to a 1.6 station as SignedUpdateFirmware (1.6 Security Whitepaper, the 1.6
 * form of 2.1 L01 secure firmware update). Without them it is the plain 1.6
 * UpdateFirmware.
 */
function isSignedFirmwareUpdate(payload: Record<string, unknown>): boolean {
  const firmware = payload.firmware as Record<string, unknown> | undefined;
  return typeof firmware?.signingCertificate === 'string' && typeof firmware.signature === 'string';
}

function mapUpdateFirmware16(payload: Record<string, unknown>): Record<string, unknown> {
  const firmware = payload.firmware as Record<string, unknown> | undefined;
  if (firmware != null && isSignedFirmwareUpdate(payload)) {
    return {
      requestId: payload.requestId,
      retries: payload.retries,
      retryInterval: payload.retryInterval,
      firmware: {
        location: firmware.location,
        retrieveDateTime: firmware.retrieveDateTime,
        installDateTime: firmware.installDateTime,
        signingCertificate: firmware.signingCertificate,
        signature: firmware.signature,
      },
    };
  }
  return {
    location: firmware?.location ?? payload.location,
    retrieveDate: firmware?.retrieveDateTime ?? payload.retrieveDate,
    retries: payload.retries,
    retryInterval: payload.retryInterval,
  };
}

// OCPP 1.6 Security Whitepaper certificate types. 2.1 types without a 1.6
// equivalent (V2G, MO, OEM roots, V2G chains) are not supported on 1.6 stations.
const CERTIFICATE_TYPE_16: Record<string, string> = {
  CSMSRootCertificate: 'CentralSystemRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
};
const CERTIFICATE_TYPE_21: Record<string, string> = {
  CentralSystemRootCertificate: 'CSMSRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
};

function certificateType16(type: unknown): string {
  const mapped = typeof type === 'string' ? CERTIFICATE_TYPE_16[type] : undefined;
  if (mapped == null) {
    throw new Error(
      `Certificate type "${String(type)}" is not supported on ocpp1.6 stations ` +
        `(only CSMSRootCertificate and ManufacturerRootCertificate).`,
    );
  }
  return mapped;
}

// CertificateHashDataType without 2.1-only fields (customData).
function certificateHashData16(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    hashAlgorithm: d.hashAlgorithm,
    issuerNameHash: d.issuerNameHash,
    issuerKeyHash: d.issuerKeyHash,
    serialNumber: d.serialNumber,
  };
}

// ---- ISO 15118 Plug and Charge on 1.6 stations ----
// OCA application note "Using ISO 15118 Plug & Charge with OCPP 1.6" (v1.0):
// the ISO 15118 certificate messages go in a DataTransfer (vendorId
// org.openchargealliance.iso15118pnc, the message as JSON in data), the
// Security Whitepaper messages stay for the station's own certificates (2.3).
// The note covers the ISO 15118-2 V2G certificate only (V2G20Certificate has
// no 1.6 form).

/** Installable root types of the note (InstallCertificateUseEnumType, 8.12). */
const PNC16_INSTALL_TYPES = new Set(['V2GRootCertificate', 'MORootCertificate']);
/** Listed types of the note (GetCertificateIdUseEnumType, 8.7). */
const PNC16_LIST_TYPES = new Set([
  'V2GRootCertificate',
  'MORootCertificate',
  'V2GCertificateChain',
]);
/** Station certificates the note's DeleteCertificate covers (2.3). */
const PNC16_DELETE_TYPES = new Set([
  'V2GRootCertificate',
  'MORootCertificate',
  'V2GCertificateChain',
  'V2GCertificate',
]);

function isV2gCertificate(type: unknown): boolean {
  return type === 'V2GCertificate' || type === 'V2G20Certificate';
}

function noV2g20On16(type: unknown): void {
  if (type === 'V2G20Certificate') {
    throw new Error(
      'V2G20Certificate is not supported on ocpp1.6 stations (the ISO 15118 application note covers ISO 15118-2).',
    );
  }
}

/** The wrapped answer's `status`, or `fallback` when the DataTransfer was not accepted. */
function pnc16Status(response: Record<string, unknown>, fallback: string): Record<string, unknown> {
  const inner = unwrapPnc16Answer(response);
  return { status: typeof inner?.['status'] === 'string' ? inner['status'] : fallback };
}

function wrappedInstall(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.certificateType === 'string' && PNC16_INSTALL_TYPES.has(payload.certificateType)
  );
}

function wrappedList(payload: Record<string, unknown>): boolean {
  const types = payload.certificateType as unknown[] | undefined;
  if (types == null || types.length === 0) return false;
  const iso = types.filter((t) => typeof t === 'string' && PNC16_LIST_TYPES.has(t));
  if (iso.length > 0 && iso.length !== types.length) {
    throw new Error(
      'GetInstalledCertificateIds to an ocpp1.6 station cannot mix ISO 15118 and Security Whitepaper certificate types.',
    );
  }
  return iso.length > 0;
}

function wrappedDelete(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.certificateType === 'string' && PNC16_DELETE_TYPES.has(payload.certificateType)
  );
}

// The 1.6 Security Whitepaper CertificateSigned.req has only certificateChain
// (additionalProperties false): the 2.1 certificateType and requestId are dropped.
function mapCertificateSigned16(payload: Record<string, unknown>): Record<string, unknown> {
  return { certificateChain: payload['certificateChain'] };
}

function mapInstallCertificate16(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    certificateType: certificateType16(payload.certificateType),
    certificate: payload.certificate,
  };
}

function mapDeleteCertificate16(payload: Record<string, unknown>): Record<string, unknown> {
  return { certificateHashData: certificateHashData16(payload.certificateHashData) };
}

// 2.1 asks for any number of types; a 1.6 request names exactly one.
function mapGetInstalledCertificateIds16(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const types = payload.certificateType as unknown[] | undefined;
  if (types?.length !== 1) {
    throw new Error(
      'GetInstalledCertificateIds to an ocpp1.6 station must request exactly one certificate ' +
        `type; received ${String(types?.length ?? 0)}.`,
    );
  }
  return { certificateType: certificateType16(types[0]) };
}

// 1.6 lists hash data for the requested type; 2.1 reports a chain entry per certificate.
function mapGetInstalledCertificateIdsResponse16(
  response: Record<string, unknown>,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const requested = (request.certificateType as unknown[] | undefined)?.[0];
  const type16 = typeof requested === 'string' ? CERTIFICATE_TYPE_16[requested] : undefined;
  const certificateType = type16 != null ? CERTIFICATE_TYPE_21[type16] : requested;
  const hashData = (response.certificateHashData as unknown[] | undefined) ?? [];
  const result: Record<string, unknown> = { status: response.status };
  if (hashData.length > 0) {
    result.certificateHashDataChain = hashData.map((data) => ({
      certificateType,
      certificateHashData: certificateHashData16(data),
    }));
  }
  return result;
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
      // SignV2GCertificate is the note's TriggerMessage in a DataTransfer (no
      // fields, 6.9); every other message is the OCPP 1.6 TriggerMessage.
      action: 'TriggerMessage',
      resolveAction: (payload) => {
        if (payload.requestedMessage === 'SignV2G20Certificate') noV2g20On16('V2G20Certificate');
        return payload.requestedMessage === 'SignV2GCertificate'
          ? 'DataTransfer'
          : 'TriggerMessage';
      },
      translatePayload: (payload) =>
        payload.requestedMessage === 'SignV2GCertificate'
          ? wrapPnc16('TriggerMessage', {})
          : payload,
      translateResponse: (response, request) =>
        request.requestedMessage === 'SignV2GCertificate'
          ? pnc16Status(response, 'Rejected')
          : response,
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
      translateResponse: mapGetCompositeScheduleResponse16,
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
      resolveAction: (payload) =>
        isSignedFirmwareUpdate(payload) ? 'SignedUpdateFirmware' : 'UpdateFirmware',
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
      // A V2G certificate goes in the note's DataTransfer (3.1), the station
      // certificate in the Security Whitepaper message.
      action: 'CertificateSigned',
      resolveAction: (payload) => {
        noV2g20On16(payload.certificateType);
        return isV2gCertificate(payload.certificateType) ? 'DataTransfer' : 'CertificateSigned';
      },
      translatePayload: (payload) =>
        isV2gCertificate(payload.certificateType)
          ? wrapPnc16('CertificateSigned', { certificateChain: payload.certificateChain })
          : mapCertificateSigned16(payload),
      translateResponse: (response, request) =>
        isV2gCertificate(request.certificateType) ? pnc16Status(response, 'Rejected') : response,
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
      resolveAction: (payload) => (wrappedInstall(payload) ? 'DataTransfer' : 'InstallCertificate'),
      translatePayload: (payload) =>
        wrappedInstall(payload)
          ? wrapPnc16('InstallCertificate', {
              certificateType: payload.certificateType,
              certificate: payload.certificate,
            })
          : mapInstallCertificate16(payload),
      translateResponse: (response, request) =>
        wrappedInstall(request) ? pnc16Status(response, 'Rejected') : response,
    },
  },
  DeleteCertificate: {
    // `certificateType` is the CSMS's hint (the type of the station
    // certificate the hash data names), never sent: it picks the 1.6 message.
    'ocpp2.1': {
      action: 'DeleteCertificate',
      translatePayload: (payload) => ({ certificateHashData: payload.certificateHashData }),
      translateResponse: identity,
    },
    'ocpp1.6': {
      action: 'DeleteCertificate',
      resolveAction: (payload) => (wrappedDelete(payload) ? 'DataTransfer' : 'DeleteCertificate'),
      translatePayload: (payload) =>
        wrappedDelete(payload)
          ? wrapPnc16('DeleteCertificate', {
              certificateHashData: certificateHashData16(payload.certificateHashData),
            })
          : mapDeleteCertificate16(payload),
      translateResponse: (response, request) =>
        wrappedDelete(request) ? pnc16Status(response, 'Failed') : response,
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
      resolveAction: (payload) =>
        wrappedList(payload) ? 'DataTransfer' : 'GetInstalledCertificateIds',
      translatePayload: (payload) =>
        wrappedList(payload)
          ? wrapPnc16('GetInstalledCertificateIds', { certificateType: payload.certificateType })
          : mapGetInstalledCertificateIds16(payload),
      translateResponse: (response, request) => {
        if (!wrappedList(request))
          return mapGetInstalledCertificateIdsResponse16(response, request);
        const inner = unwrapPnc16Answer(response);
        if (inner == null || typeof inner['status'] !== 'string') return { status: 'NotFound' };
        return {
          status: inner['status'],
          ...(Array.isArray(inner['certificateHashDataChain'])
            ? { certificateHashDataChain: inner['certificateHashDataChain'] }
            : {}),
        };
      },
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
    action: translation.resolveAction?.(payload) ?? translation.action,
    payload: translation.translatePayload(payload),
  };
}

export function translateResponse(
  commandName: string,
  version: string,
  response: Record<string, unknown>,
  request: Record<string, unknown> = {},
): Record<string, unknown> {
  const translation = commandMap[commandName]?.[version];
  if (translation == null) return response;
  return translation.translateResponse(response, request);
}
