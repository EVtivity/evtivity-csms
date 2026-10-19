// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  OCPP201_MESSAGE_CONTENT_MAX_LENGTH,
  OCPP21_ONLY_MESSAGE_FORMATS,
  OCPP21_ONLY_MESSAGE_STATES,
  OCPP21_ONLY_MONITOR_TYPES,
  OCPP21_ONLY_PROFILE_PURPOSES,
  chargingProfileForOcpp201,
  isOcpp21OnlyAction,
} from '@evtivity/lib';
import type { AjvError } from '../ocpp-registry.js';
import { ocpp201ActionSchemaEntry, ocpp21ActionSchemaEntry } from '../ocpp-registry.js';

type Obj = Record<string, unknown>;

/** A command the CSMS cannot express in OCPP 2.0.1. It is refused before it is sent. */
export class Ocpp201CommandError extends Error {
  constructor(action: string, reason: string) {
    super(`${action} cannot be sent to an OCPP 2.0.1 station: ${reason}`);
    this.name = 'Ocpp201CommandError';
  }
}

const ID_TOKEN_TYPES = new Set([
  'Central',
  'eMAID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
]);
const ID_TOKEN_MAX_LENGTH = 36;
const MESSAGE_CONTENT_MAX_LENGTH = OCPP201_MESSAGE_CONTENT_MAX_LENGTH;
const STATUS_INFO_MAX_LENGTH = 512;
const MESSAGE_FORMATS_21_ONLY = new Set(OCPP21_ONLY_MESSAGE_FORMATS);
const MESSAGE_STATES_21_ONLY = new Set(OCPP21_ONLY_MESSAGE_STATES);
const MONITOR_TYPES_21_ONLY = new Set(OCPP21_ONLY_MONITOR_TYPES);
const PROFILE_PURPOSES_21_ONLY = new Set(OCPP21_ONLY_PROFILE_PURPOSES);

function isObj(value: unknown): value is Obj {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function objects(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

function fieldPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function longerThan(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > max;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

function idTokenFits(token: Obj): boolean {
  if (typeof token['type'] !== 'string' || !ID_TOKEN_TYPES.has(token['type'])) return false;
  if (longerThan(token['idToken'], ID_TOKEN_MAX_LENGTH)) return false;
  return objects(token['additionalInfo']).every(
    (info) => !longerThan(info['additionalIdToken'], ID_TOKEN_MAX_LENGTH),
  );
}

/** A QR code has no 2.0.1 form, so the message is left out; a longer text is cut to 512. */
function messageContentForReply(message: unknown): Obj | undefined {
  if (!isObj(message)) return undefined;
  if (MESSAGE_FORMATS_21_ONLY.has(String(message['format']))) return undefined;
  const content = message['content'];
  if (typeof content === 'string' && content.length > MESSAGE_CONTENT_MAX_LENGTH) {
    return { ...message, content: content.slice(0, MESSAGE_CONTENT_MAX_LENGTH) };
  }
  return message;
}

/** A copy of the object without the key. */
function without(obj: Obj, key: string): Obj {
  const copy = { ...obj };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing one known key from a copy
  delete copy[key];
  return copy;
}

function withOptional(payload: Obj, key: string, value: Obj | undefined): Obj {
  return value == null ? without(payload, key) : { ...payload, [key]: value };
}

function idTokenInfoForReply(info: unknown): unknown {
  if (!isObj(info)) return info;
  let mapped = info;
  if (isObj(info['groupIdToken']) && !idTokenFits(info['groupIdToken'])) {
    mapped = withOptional(mapped, 'groupIdToken', undefined);
  }
  if (info['personalMessage'] != null) {
    mapped = withOptional(
      mapped,
      'personalMessage',
      messageContentForReply(info['personalMessage']),
    );
  }
  return mapped;
}

function statusInfoForReply(payload: Obj): Obj {
  const statusInfo = payload['statusInfo'];
  if (!isObj(statusInfo)) return payload;
  const info = statusInfo['additionalInfo'];
  if (typeof info !== 'string' || info.length <= STATUS_INFO_MAX_LENGTH) return payload;
  return {
    ...payload,
    statusInfo: { ...statusInfo, additionalInfo: info.slice(0, STATUS_INFO_MAX_LENGTH) },
  };
}

const replyMappers: Readonly<Record<string, (payload: Obj) => Obj>> = {
  Authorize: (p) => ({ ...p, idTokenInfo: idTokenInfoForReply(p['idTokenInfo']) }),
  TransactionEvent: (p) => {
    let mapped: Obj =
      p['idTokenInfo'] != null ? { ...p, idTokenInfo: idTokenInfoForReply(p['idTokenInfo']) } : p;
    if (p['updatedPersonalMessage'] != null) {
      mapped = withOptional(
        mapped,
        'updatedPersonalMessage',
        messageContentForReply(p['updatedPersonalMessage']),
      );
    }
    return mapped;
  },
  // 2.1 NoChargingProfile is the 2.0.1 Rejected: no schedule will follow, the
  // station uses its default profile (2.0.1 K15.FR.04).
  NotifyEVChargingNeeds: (p) =>
    p['status'] === 'NoChargingProfile' ? { ...p, status: 'Rejected' } : p,
};

/**
 * Turns the reply a 2.1 handler produced into the reply sent to an OCPP 2.0.1
 * station: values 2.0.1 cannot carry are mapped (a group token outside the
 * 2.0.1 token types left out, a QR code message left out, texts cut to the
 * 2.0.1 length), then the generated fit removes every property 2.0.1 does not
 * allow. The handler's object is not changed. The caller validates the result
 * against the 2.0.1 schema. An action 2.0.1 does not define is returned unchanged.
 */
export function toOcpp201Reply(action: string, payload: Obj): Obj {
  const entry = ocpp201ActionSchemaEntry(action);
  if (entry == null) return payload;
  const mapper = Object.hasOwn(replyMappers, action) ? replyMappers[action] : undefined;
  const mapped = statusInfoForReply(mapper == null ? payload : mapper(payload));
  return entry.fitResponse(mapped);
}

// ---------------------------------------------------------------------------
// Inbound requests
// ---------------------------------------------------------------------------

const BOUND_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);

/**
 * The numeric bounds a 2.0.1 request breaks that OCPP 2.1 sets (a negative
 * evseId, connectorId, seqNo or id; more than 3 phases). The 2.0.1 schemas
 * leave these open, but the 2.1 handlers rely on them (an EVSE -1 would be
 * created), so such a request is refused. Empty when the request keeps them.
 */
export function ocpp201RequestBoundErrors(action: string, payload: unknown): AjvError[] {
  const entry = ocpp21ActionSchemaEntry(action);
  if (entry == null || entry.validateRequest(payload)) return [];
  return (entry.validateRequest.errors ?? []).filter(
    (e) => e.keyword != null && BOUND_KEYWORDS.has(e.keyword),
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Refuse = (reason: string) => never;

function checkIdToken(token: unknown, path: string, refuse: Refuse): void {
  if (!isObj(token)) return;
  const type = token['type'];
  if (typeof type !== 'string' || !ID_TOKEN_TYPES.has(type)) {
    refuse(`${path}.type ${String(type)} is not an OCPP 2.0.1 token type`);
  }
  if (longerThan(token['idToken'], ID_TOKEN_MAX_LENGTH)) {
    refuse(`${path}.idToken is longer than ${String(ID_TOKEN_MAX_LENGTH)} characters`);
  }
  for (const info of objects(token['additionalInfo'])) {
    if (longerThan(info['additionalIdToken'], ID_TOKEN_MAX_LENGTH)) {
      refuse(
        `${path}.additionalInfo.additionalIdToken is longer than ${String(ID_TOKEN_MAX_LENGTH)} characters`,
      );
    }
  }
}

function checkMessageContent(message: unknown, path: string, refuse: Refuse): void {
  if (!isObj(message)) return;
  if (MESSAGE_FORMATS_21_ONLY.has(String(message['format']))) {
    refuse(`${path}.format ${String(message['format'])} is not defined in OCPP 2.0.1`);
  }
  if (longerThan(message['content'], MESSAGE_CONTENT_MAX_LENGTH)) {
    refuse(`${path}.content is longer than ${String(MESSAGE_CONTENT_MAX_LENGTH)} characters`);
  }
}

function checkIdTokenInfo(info: unknown, path: string, refuse: Refuse): void {
  if (!isObj(info)) return;
  checkIdToken(info['groupIdToken'], `${path}.groupIdToken`, refuse);
  checkMessageContent(info['personalMessage'], `${path}.personalMessage`, refuse);
}

function checkEnum(
  value: unknown,
  values21Only: ReadonlySet<string>,
  path: string,
  refuse: Refuse,
): void {
  if (typeof value === 'string' && values21Only.has(value)) {
    refuse(`${path} ${value} is not defined in OCPP 2.0.1`);
  }
}

function refuseFields(obj: Obj, keys: readonly string[], path: string, refuse: Refuse): void {
  for (const key of keys) {
    if (obj[key] != null) refuse(`${fieldPath(path, key)} is not defined in OCPP 2.0.1`);
  }
}

function withProfile(p: Obj, refuse: Refuse): Obj {
  return p['chargingProfile'] == null
    ? p
    : { ...p, chargingProfile: chargingProfileForOcpp201(p['chargingProfile'], refuse) };
}

function networkProfileFor201(p: Obj, refuse: Refuse): Obj {
  const data = p['connectionData'];
  if (!isObj(data)) return p;
  if (data['identity'] != null) {
    refuse(
      'connectionData.identity is not defined in OCPP 2.0.1 (the station id is the Basic Auth username)',
    );
  }
  if (data['basicAuthPassword'] != null) {
    refuse(
      'connectionData.basicAuthPassword is not defined in OCPP 2.0.1 (set SecurityCtrlr.BasicAuthPassword with SetVariables)',
    );
  }
  if (data['ocppInterface'] === 'Any') {
    refuse('connectionData.ocppInterface Any is not defined in OCPP 2.0.1');
  }
  const version = data['ocppVersion'];
  if (version === 'OCPP21') {
    refuse('connectionData.ocppVersion OCPP21 is not defined in OCPP 2.0.1');
  }
  // 2.0.1 requires the version and names itself OCPP20.
  const ocppVersion = version == null || version === 'OCPP201' ? 'OCPP20' : version;
  return { ...p, connectionData: { ...data, ocppVersion } };
}

const commandMappers: Readonly<Record<string, (payload: Obj, refuse: Refuse) => Obj>> = {
  RequestStartTransaction: (p, refuse) => {
    checkIdToken(p['idToken'], 'idToken', refuse);
    checkIdToken(p['groupIdToken'], 'groupIdToken', refuse);
    return withProfile(p, refuse);
  },
  SetChargingProfile: (p, refuse) => withProfile(p, refuse),
  ClearChargingProfile: (p, refuse) => {
    const criteria = p['chargingProfileCriteria'];
    if (isObj(criteria)) {
      checkEnum(
        criteria['chargingProfilePurpose'],
        PROFILE_PURPOSES_21_ONLY,
        'chargingProfileCriteria.chargingProfilePurpose',
        refuse,
      );
    }
    return p;
  },
  GetChargingProfiles: (p, refuse) => {
    const criteria = p['chargingProfile'];
    if (isObj(criteria)) {
      checkEnum(
        criteria['chargingProfilePurpose'],
        PROFILE_PURPOSES_21_ONLY,
        'chargingProfile.chargingProfilePurpose',
        refuse,
      );
    }
    return p;
  },
  ReserveNow: (p, refuse) => {
    checkIdToken(p['idToken'], 'idToken', refuse);
    checkIdToken(p['groupIdToken'], 'groupIdToken', refuse);
    return p;
  },
  CustomerInformation: (p, refuse) => {
    checkIdToken(p['idToken'], 'idToken', refuse);
    return p;
  },
  SendLocalList: (p, refuse) => {
    objects(p['localAuthorizationList']).forEach((entry, i) => {
      checkIdToken(entry['idToken'], `localAuthorizationList[${String(i)}].idToken`, refuse);
      checkIdTokenInfo(
        entry['idTokenInfo'],
        `localAuthorizationList[${String(i)}].idTokenInfo`,
        refuse,
      );
    });
    return p;
  },
  SetDisplayMessage: (p, refuse) => {
    const message = p['message'];
    if (!isObj(message)) return p;
    checkMessageContent(message['message'], 'message.message', refuse);
    checkEnum(message['state'], MESSAGE_STATES_21_ONLY, 'message.state', refuse);
    // Extra languages of the same message: the station still shows the main one.
    if (!Object.hasOwn(message, 'messageExtra')) return p;
    return { ...p, message: without(message, 'messageExtra') };
  },
  GetDisplayMessages: (p, refuse) => {
    checkEnum(p['state'], MESSAGE_STATES_21_ONLY, 'state', refuse);
    return p;
  },
  SetNetworkProfile: (p, refuse) => networkProfileFor201(p, refuse),
  TriggerMessage: (p, refuse) => {
    checkEnum(
      p['requestedMessage'],
      new Set(['SignV2G20Certificate', 'CustomTrigger']),
      'requestedMessage',
      refuse,
    );
    refuseFields(p, ['customTrigger'], '', refuse);
    return p;
  },
  Reset: (p, refuse) => {
    checkEnum(p['type'], new Set(['ImmediateAndResume']), 'type', refuse);
    return p;
  },
  GetLog: (p, refuse) => {
    checkEnum(p['logType'], new Set(['DataCollectorLog']), 'logType', refuse);
    return p;
  },
  SetVariableMonitoring: (p, refuse) => {
    objects(p['setMonitoringData']).forEach((data, i) => {
      const path = `setMonitoringData[${String(i)}]`;
      checkEnum(data['type'], MONITOR_TYPES_21_ONLY, `${path}.type`, refuse);
      refuseFields(data, ['periodicEventStream'], path, refuse);
    });
    return p;
  },
  InstallCertificate: (p, refuse) => {
    checkEnum(p['certificateType'], new Set(['OEMRootCertificate']), 'certificateType', refuse);
    return p;
  },
  GetInstalledCertificateIds: (p, refuse) => {
    const types: unknown[] = Array.isArray(p['certificateType']) ? p['certificateType'] : [];
    for (const type of types) {
      checkEnum(type, new Set(['OEMRootCertificate']), 'certificateType', refuse);
    }
    return p;
  },
  CertificateSigned: (p, refuse) => {
    checkEnum(p['certificateType'], new Set(['V2G20Certificate']), 'certificateType', refuse);
    // Correlates the answer with a 2.1 SignCertificate request id, which 2.0.1 does not have.
    if (!Object.hasOwn(p, 'requestId')) return p;
    return without(p, 'requestId');
  },
};

/**
 * Maps a 2.1 command payload to OCPP 2.0.1 before the fit. A value that would
 * change the command's meaning in 2.0.1 (a token type 2.0.1 does not define, a
 * QR code, a setpoint, a 2.1-only enum value) throws `Ocpp201CommandError`. A
 * 2.1-only field whose absence keeps the meaning is dropped (`operationMode:
 * ChargingOnly`, `evseSleep: false`, display message `messageExtra`). The
 * input is not changed.
 */
export function toOcpp201Command(action: string, payload: Obj): Obj {
  const mapper = Object.hasOwn(commandMappers, action) ? commandMappers[action] : undefined;
  if (mapper == null) return payload;
  const refuse: Refuse = (reason) => {
    throw new Ocpp201CommandError(action, reason);
  };
  return mapper(payload, refuse);
}

function describeErrors(errors: readonly AjvError[]): string {
  return errors
    .slice(0, 5)
    .map(
      (e) =>
        `${e.instancePath === '' || e.instancePath == null ? '/' : e.instancePath} ${e.message ?? e.keyword ?? 'invalid'}`,
    )
    .join('; ');
}

/**
 * The one check every CALL to an OCPP 2.0.1 station passes: a 2.1-only action
 * is refused, the payload is mapped (`toOcpp201Command`), fitted to the 2.0.1
 * schema and validated strictly. Throws `Ocpp201CommandError` with the reason
 * (the schema errors included) when the command cannot be sent.
 */
export function prepareOcpp201Command(action: string, payload: Obj): Obj {
  const entry = ocpp201ActionSchemaEntry(action);
  if (entry == null) {
    throw new Ocpp201CommandError(
      action,
      isOcpp21OnlyAction(action)
        ? 'the action is defined in OCPP 2.1 only'
        : 'the action is not defined in OCPP 2.0.1',
    );
  }
  const fitted = entry.fitRequest(toOcpp201Command(action, payload));
  if (!entry.validateRequest(fitted)) {
    throw new Ocpp201CommandError(
      action,
      `the payload does not match the OCPP 2.0.1 schema: ${describeErrors(entry.validateRequest.errors ?? [])}`,
    );
  }
  return fitted;
}
