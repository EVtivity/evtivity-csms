// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP version of the assistant's station command tools. The command routes
 * are per version (`/v1/ocpp/commands/v16/*`, `/v1/ocpp/commands/v21/*`) and
 * send the payload to the station as it is, so a 1.6 tool aimed at a 2.1
 * station (or the reverse) cannot work. Before such a write is proposed, the
 * engine looks up the station's version (`engine/turn.ts`) and calls
 * `mapOcppCommand`: the call becomes the equivalent tool of the station's
 * version with translated arguments, or a tool error that names the version.
 *
 * The argument translations follow the OCPP server's command translation
 * (`packages/ocpp/src/server/command-translation.ts`): Reset Hard/Soft is
 * Immediate/OnIdle, a 1.6 connector is the 2.1 EVSE with the same id, and a
 * 1.6 idTag a 2.1 idToken of type Central (the type the CSMS sends a driver
 * id as). A translation that would drop or guess a value is refused instead.
 */

import { randomInt } from 'node:crypto';
import type { AiCatalogTool } from './catalog-types.js';

export type OcppVersion = 'ocpp1.6' | 'ocpp2.1';

const COMMAND_PATH = /^\/v1\/ocpp\/commands\/v(16|21)\//;

/** The OCPP version a station command tool is for, or null for any other tool. */
export function toolOcppVersion(tool: Pick<AiCatalogTool, 'pathTemplate'>): OcppVersion | null {
  const match = COMMAND_PATH.exec(tool.pathTemplate);
  if (match === null) return null;
  return match[1] === '16' ? 'ocpp1.6' : 'ocpp2.1';
}

/** `ocpp1.6` as "OCPP 1.6". */
export function ocppVersionLabel(version: OcppVersion): string {
  return version === 'ocpp1.6' ? 'OCPP 1.6' : 'OCPP 2.1';
}

/**
 * A station command tool's description with its version rule, so the model
 * checks the station's version before picking it. Guidance only: the engine
 * checks the version itself before a write is proposed.
 */
export function ocppToolDescription(
  tool: Pick<AiCatalogTool, 'description' | 'pathTemplate'>,
): string {
  const version = toolOcppVersion(tool);
  if (version === null) return tool.description;
  return `${tool.description}. For ${ocppVersionLabel(version)} stations: check the station's OCPP version (ocppProtocol) first when you can. The server maps the command to the station's version.`;
}

type Args = Record<string, unknown>;

type Translation = { operationId: string; args: Args } | { unsupported: string };

export type OcppCommandMapping =
  /** The tool already matches the station's version. */
  | { kind: 'match' }
  /** The equivalent tool of the station's version, with translated arguments. */
  | { kind: 'mapped'; operationId: string; args: Args }
  /** No equivalent: the text tells the model why and what to use. */
  | { kind: 'unsupported'; message: string };

export interface MapOptions {
  /** The RequestStartTransaction correlation id a 1.6 remote start gets (random by default). */
  remoteStartId?: () => number;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Args {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** An argument as text for a lookup or a message: a string as is, anything else as JSON. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A 2.1 string transaction id as the positive integer 1.6 needs, or undefined. */
function transactionId16(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const n = Number(value);
  return n <= 2_147_483_647 ? n : undefined;
}

/** Keys of `obj` that are not in `allowed`. */
function extraKeys(obj: Args, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k) && obj[k] !== undefined);
}

/** `obj` without the undefined values. */
function defined(obj: Args): Args {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** A 1.6 idTag holds at most 20 characters. */
const ID_TAG_MAX = 20;

const PURPOSE_TO_21: Record<string, string> = {
  ChargePointMaxProfile: 'ChargingStationMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
};
const PURPOSE_TO_16: Record<string, string> = {
  ChargingStationMaxProfile: 'ChargePointMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
};

// ---------------------------------------------------------------------------
// Charging profiles
// ---------------------------------------------------------------------------

const PROFILE_16_KEYS = [
  'chargingProfileId',
  'transactionId',
  'stackLevel',
  'chargingProfilePurpose',
  'chargingProfileKind',
  'recurrencyKind',
  'validFrom',
  'validTo',
  'chargingSchedule',
];
const PROFILE_21_KEYS = [
  'id',
  'transactionId',
  'stackLevel',
  'chargingProfilePurpose',
  'chargingProfileKind',
  'recurrencyKind',
  'validFrom',
  'validTo',
  'chargingSchedule',
];
const SCHEDULE_16_KEYS = [
  'duration',
  'startSchedule',
  'chargingRateUnit',
  'chargingSchedulePeriod',
  'minChargingRate',
];
const SCHEDULE_21_KEYS = ['id', ...SCHEDULE_16_KEYS];
const PERIOD_KEYS = ['startPeriod', 'limit', 'numberPhases'];

function periods(value: unknown): Args[] | string {
  if (!Array.isArray(value)) return 'the charging schedule has no periods';
  const out: Args[] = [];
  for (const period of value) {
    if (!isObject(period)) return 'a charging schedule period is not an object';
    const extra = extraKeys(period, PERIOD_KEYS);
    if (extra.length > 0) return `the schedule period field ${extra.join(', ')} has no equivalent`;
    if (typeof period['limit'] !== 'number') return 'a schedule period has no limit';
    out.push(
      defined({
        startPeriod: period['startPeriod'],
        limit: period['limit'],
        numberPhases: period['numberPhases'],
      }),
    );
  }
  return out;
}

function profileTo21(profile: unknown): Args | string {
  if (!isObject(profile)) return 'the charging profile is missing';
  const extra = extraKeys(profile, PROFILE_16_KEYS);
  if (extra.length > 0) return `the charging profile field ${extra.join(', ')} has no equivalent`;
  const schedule = profile['chargingSchedule'];
  if (!isObject(schedule)) return 'the charging profile has no schedule';
  const scheduleExtra = extraKeys(schedule, SCHEDULE_16_KEYS);
  if (scheduleExtra.length > 0) {
    return `the charging schedule field ${scheduleExtra.join(', ')} has no equivalent`;
  }
  const purpose = PURPOSE_TO_21[text(profile['chargingProfilePurpose'])];
  if (purpose === undefined) return 'the charging profile purpose has no equivalent';
  const schedulePeriods = periods(schedule['chargingSchedulePeriod']);
  if (typeof schedulePeriods === 'string') return schedulePeriods;
  const tx = profile['transactionId'];
  return defined({
    id: profile['chargingProfileId'],
    stackLevel: profile['stackLevel'],
    chargingProfilePurpose: purpose,
    chargingProfileKind: profile['chargingProfileKind'],
    recurrencyKind: profile['recurrencyKind'],
    validFrom: profile['validFrom'],
    validTo: profile['validTo'],
    transactionId: typeof tx === 'number' ? String(tx) : undefined,
    chargingSchedule: [
      defined({
        // 2.1 schedules carry an id; the profile id is unique per station.
        id: profile['chargingProfileId'],
        chargingRateUnit: schedule['chargingRateUnit'],
        chargingSchedulePeriod: schedulePeriods,
        duration: schedule['duration'],
        startSchedule: schedule['startSchedule'],
        minChargingRate: schedule['minChargingRate'],
      }),
    ],
  });
}

function profileTo16(profile: unknown): Args | string {
  if (!isObject(profile)) return 'the charging profile is missing';
  const extra = extraKeys(profile, PROFILE_21_KEYS);
  if (extra.length > 0) return `the charging profile field ${extra.join(', ')} has no equivalent`;
  if (profile['chargingProfileKind'] === 'Dynamic') {
    return 'the Dynamic charging profile kind has no equivalent';
  }
  const purpose = PURPOSE_TO_16[text(profile['chargingProfilePurpose'])];
  if (purpose === undefined) return 'the charging profile purpose has no equivalent';
  const schedules = profile['chargingSchedule'];
  if (!Array.isArray(schedules) || schedules.length !== 1 || !isObject(schedules[0])) {
    return 'OCPP 1.6 takes exactly one charging schedule';
  }
  const schedule = schedules[0];
  const scheduleExtra = extraKeys(schedule, SCHEDULE_21_KEYS);
  if (scheduleExtra.length > 0) {
    return `the charging schedule field ${scheduleExtra.join(', ')} has no equivalent`;
  }
  const schedulePeriods = periods(schedule['chargingSchedulePeriod']);
  if (typeof schedulePeriods === 'string') return schedulePeriods;
  let transactionId: number | undefined;
  if (profile['transactionId'] !== undefined) {
    transactionId = transactionId16(profile['transactionId']);
    if (transactionId === undefined) return 'OCPP 1.6 needs a numeric transaction id';
  }
  return defined({
    chargingProfileId: profile['id'],
    transactionId,
    stackLevel: profile['stackLevel'],
    chargingProfilePurpose: purpose,
    chargingProfileKind: profile['chargingProfileKind'],
    recurrencyKind: profile['recurrencyKind'],
    validFrom: profile['validFrom'],
    validTo: profile['validTo'],
    chargingSchedule: defined({
      duration: schedule['duration'],
      startSchedule: schedule['startSchedule'],
      chargingRateUnit: schedule['chargingRateUnit'],
      chargingSchedulePeriod: schedulePeriods,
      minChargingRate: schedule['minChargingRate'],
    }),
  });
}

// ---------------------------------------------------------------------------
// Translations, by the operationId of the tool the model called
// ---------------------------------------------------------------------------

const RESET_TO_21: Record<string, string> = { Hard: 'Immediate', Soft: 'OnIdle' };
const RESET_TO_16: Record<string, string> = { Immediate: 'Hard', OnIdle: 'Soft' };

/** 2.1 trigger messages and the 1.6 tool that sends each one. */
const TRIGGER_TO_16: Record<string, { operationId: string; message: string }> = {
  BootNotification: { operationId: 'ocppv16_TriggerMessage', message: 'BootNotification' },
  FirmwareStatusNotification: {
    operationId: 'ocppv16_TriggerMessage',
    message: 'FirmwareStatusNotification',
  },
  Heartbeat: { operationId: 'ocppv16_TriggerMessage', message: 'Heartbeat' },
  MeterValues: { operationId: 'ocppv16_TriggerMessage', message: 'MeterValues' },
  StatusNotification: { operationId: 'ocppv16_TriggerMessage', message: 'StatusNotification' },
  LogStatusNotification: {
    operationId: 'ocppv16_ExtendedTriggerMessage',
    message: 'LogStatusNotification',
  },
  SignChargingStationCertificate: {
    operationId: 'ocppv16_ExtendedTriggerMessage',
    message: 'SignChargePointCertificate',
  },
};

/** 1.6 (extended) trigger messages as 2.1 ones. */
const TRIGGER_TO_21: Record<string, string> = {
  BootNotification: 'BootNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  StatusNotification: 'StatusNotification',
  LogStatusNotification: 'LogStatusNotification',
  SignChargePointCertificate: 'SignChargingStationCertificate',
};

/** The 2.1 `evse` object of a 1.6 connector (0 or none is the whole station). */
function evse21(connectorId: unknown): Args {
  const id = positiveInt(connectorId);
  return id !== undefined ? { evse: { id } } : {};
}

function same(operationId: string): (args: Args) => Translation {
  return (args) => ({ operationId, args });
}

function trigger21(args: Args): Translation {
  const message = TRIGGER_TO_21[text(args['requestedMessage'])];
  if (message === undefined) {
    return { unsupported: `the ${text(args['requestedMessage'])} trigger has no equivalent` };
  }
  return {
    operationId: 'ocppv21_TriggerMessage',
    args: {
      stationId: args['stationId'],
      requestedMessage: message,
      ...evse21(args['connectorId']),
    },
  };
}

function translators16To21(options: MapOptions): Record<string, (args: Args) => Translation> {
  return {
    ocppv16_Reset: (args) => {
      const type = RESET_TO_21[text(args['type'])];
      if (type === undefined) return { unsupported: 'the reset type has no equivalent' };
      return { operationId: 'ocppv21_Reset', args: { stationId: args['stationId'], type } };
    },
    ocppv16_ChangeAvailability: (args) => ({
      operationId: 'ocppv21_ChangeAvailability',
      args: {
        stationId: args['stationId'],
        operationalStatus: args['type'],
        ...evse21(args['connectorId']),
      },
    }),
    ocppv16_UnlockConnector: (args) => ({
      operationId: 'ocppv21_UnlockConnector',
      args: { stationId: args['stationId'], evseId: args['connectorId'], connectorId: 1 },
    }),
    ocppv16_RemoteStartTransaction: (args) => {
      let chargingProfile: Args | undefined;
      if (args['chargingProfile'] !== undefined) {
        const mapped = profileTo21(args['chargingProfile']);
        if (typeof mapped === 'string') return { unsupported: mapped };
        chargingProfile = mapped;
      }
      const evseId = positiveInt(args['connectorId']);
      return {
        operationId: 'ocppv21_RequestStartTransaction',
        args: defined({
          stationId: args['stationId'],
          remoteStartId: (options.remoteStartId ?? (() => randomInt(1, 2_147_483_647)))(),
          idToken: { idToken: args['idTag'], type: 'Central' },
          evseId,
          chargingProfile,
        }),
      };
    },
    ocppv16_RemoteStopTransaction: (args) => ({
      operationId: 'ocppv21_RequestStopTransaction',
      args: { stationId: args['stationId'], transactionId: text(args['transactionId']) },
    }),
    ocppv16_CancelReservation: same('ocppv21_CancelReservation'),
    ocppv16_ClearCache: same('ocppv21_ClearCache'),
    ocppv16_GetLocalListVersion: same('ocppv21_GetLocalListVersion'),
    ocppv16_TriggerMessage: trigger21,
    ocppv16_ExtendedTriggerMessage: trigger21,
    ocppv16_GetCompositeSchedule: (args) => ({
      operationId: 'ocppv21_GetCompositeSchedule',
      args: defined({
        stationId: args['stationId'],
        duration: args['duration'],
        evseId: args['connectorId'],
        chargingRateUnit: args['chargingRateUnit'],
      }),
    }),
    ocppv16_ClearChargingProfile: (args) => {
      let purpose: string | undefined;
      if (args['chargingProfilePurpose'] !== undefined) {
        purpose = PURPOSE_TO_21[text(args['chargingProfilePurpose'])];
        if (purpose === undefined) return { unsupported: 'the profile purpose has no equivalent' };
      }
      const criteria = defined({
        evseId: args['connectorId'],
        chargingProfilePurpose: purpose,
        stackLevel: args['stackLevel'],
      });
      return {
        operationId: 'ocppv21_ClearChargingProfile',
        args: defined({
          stationId: args['stationId'],
          chargingProfileId: args['id'],
          chargingProfileCriteria: Object.keys(criteria).length > 0 ? criteria : undefined,
        }),
      };
    },
    ocppv16_SetChargingProfile: (args) => {
      const profile = profileTo21(args['csChargingProfiles']);
      if (typeof profile === 'string') return { unsupported: profile };
      return {
        operationId: 'ocppv21_SetChargingProfile',
        args: {
          stationId: args['stationId'],
          evseId: args['connectorId'],
          chargingProfile: profile,
        },
      };
    },
    ocppv16_ReserveNow: (args) => {
      const parent = args['parentIdTag'];
      return {
        operationId: 'ocppv21_ReserveNow',
        args: defined({
          stationId: args['stationId'],
          id: args['reservationId'],
          expiryDateTime: args['expiryDate'],
          idToken: { idToken: args['idTag'], type: 'Central' },
          evseId: positiveInt(args['connectorId']),
          groupIdToken:
            typeof parent === 'string' ? { idToken: parent, type: 'Central' } : undefined,
        }),
      };
    },
    ocppv16_SendLocalList: () => ({
      unsupported:
        'a 2.1 local list entry needs each token type, which a 1.6 idTag does not have: call ocppv21_send_local_list with the token types',
    }),
    ocppv16_GetConfiguration: () => ({
      unsupported:
        'OCPP 2.1 reads configuration as component variables: use ocppv21_get_variables or ocppv21_get_base_report',
    }),
  };
}

const TRANSLATE_21_TO_16: Record<string, (args: Args) => Translation> = {
  ocppv21_Reset: (args) => {
    if (args['evseId'] !== undefined) {
      return { unsupported: 'OCPP 1.6 resets the whole station only, not one EVSE' };
    }
    const type = RESET_TO_16[text(args['type'])];
    if (type === undefined) {
      return { unsupported: `the ${text(args['type'])} reset type has no equivalent` };
    }
    return { operationId: 'ocppv16_Reset', args: { stationId: args['stationId'], type } };
  },
  ocppv21_ChangeAvailability: (args) => {
    const evse = isObject(args['evse']) ? args['evse'] : undefined;
    const connector = evse?.['connectorId'];
    if (connector !== undefined && connector !== 1) {
      return { unsupported: 'OCPP 1.6 addresses a connector by its EVSE number only' };
    }
    return {
      operationId: 'ocppv16_ChangeAvailability',
      args: {
        stationId: args['stationId'],
        connectorId: positiveInt(evse?.['id']) ?? 0,
        type: args['operationalStatus'],
      },
    };
  },
  ocppv21_UnlockConnector: (args) => {
    if (args['connectorId'] !== 1) {
      return { unsupported: 'OCPP 1.6 addresses a connector by its EVSE number only' };
    }
    return {
      operationId: 'ocppv16_UnlockConnector',
      args: { stationId: args['stationId'], connectorId: args['evseId'] },
    };
  },
  ocppv21_RequestStartTransaction: (args) => {
    if (args['groupIdToken'] !== undefined) {
      return { unsupported: 'a group id token has no equivalent in a 1.6 remote start' };
    }
    const token = isObject(args['idToken']) ? args['idToken']['idToken'] : undefined;
    if (typeof token !== 'string' || token.length > ID_TAG_MAX) {
      return { unsupported: `an OCPP 1.6 idTag holds at most ${String(ID_TAG_MAX)} characters` };
    }
    let chargingProfile: Args | undefined;
    if (args['chargingProfile'] !== undefined) {
      const mapped = profileTo16(args['chargingProfile']);
      if (typeof mapped === 'string') return { unsupported: mapped };
      chargingProfile = mapped;
    }
    return {
      operationId: 'ocppv16_RemoteStartTransaction',
      args: defined({
        stationId: args['stationId'],
        connectorId: args['evseId'],
        idTag: token,
        chargingProfile,
      }),
    };
  },
  ocppv21_RequestStopTransaction: (args) => {
    const transactionId = transactionId16(args['transactionId']);
    if (transactionId === undefined) {
      return { unsupported: 'OCPP 1.6 needs a numeric transaction id' };
    }
    return {
      operationId: 'ocppv16_RemoteStopTransaction',
      args: { stationId: args['stationId'], transactionId },
    };
  },
  ocppv21_CancelReservation: same('ocppv16_CancelReservation'),
  ocppv21_ClearCache: same('ocppv16_ClearCache'),
  ocppv21_GetLocalListVersion: same('ocppv16_GetLocalListVersion'),
  ocppv21_TriggerMessage: (args) => {
    if (args['customTrigger'] !== undefined) {
      return { unsupported: 'a custom trigger has no equivalent' };
    }
    const target = TRIGGER_TO_16[text(args['requestedMessage'])];
    if (target === undefined) {
      return { unsupported: `the ${text(args['requestedMessage'])} trigger has no equivalent` };
    }
    const evse = isObject(args['evse']) ? args['evse'] : undefined;
    return {
      operationId: target.operationId,
      args: defined({
        stationId: args['stationId'],
        requestedMessage: target.message,
        connectorId: positiveInt(evse?.['id']),
      }),
    };
  },
  ocppv21_GetCompositeSchedule: (args) => ({
    operationId: 'ocppv16_GetCompositeSchedule',
    args: defined({
      stationId: args['stationId'],
      connectorId: args['evseId'],
      duration: args['duration'],
      chargingRateUnit: args['chargingRateUnit'],
    }),
  }),
  ocppv21_ClearChargingProfile: (args) => {
    const criteria = isObject(args['chargingProfileCriteria'])
      ? args['chargingProfileCriteria']
      : {};
    const extra = extraKeys(criteria, ['evseId', 'chargingProfilePurpose', 'stackLevel']);
    if (extra.length > 0) {
      return { unsupported: `the criteria field ${extra.join(', ')} has no equivalent` };
    }
    let purpose: string | undefined;
    if (criteria['chargingProfilePurpose'] !== undefined) {
      purpose = PURPOSE_TO_16[text(criteria['chargingProfilePurpose'])];
      if (purpose === undefined) return { unsupported: 'the profile purpose has no equivalent' };
    }
    return {
      operationId: 'ocppv16_ClearChargingProfile',
      args: defined({
        stationId: args['stationId'],
        id: args['chargingProfileId'],
        connectorId: criteria['evseId'],
        chargingProfilePurpose: purpose,
        stackLevel: criteria['stackLevel'],
      }),
    };
  },
  ocppv21_SetChargingProfile: (args) => {
    const profile = profileTo16(args['chargingProfile']);
    if (typeof profile === 'string') return { unsupported: profile };
    return {
      operationId: 'ocppv16_SetChargingProfile',
      args: {
        stationId: args['stationId'],
        connectorId: args['evseId'] ?? 0,
        csChargingProfiles: profile,
      },
    };
  },
  ocppv21_ReserveNow: (args) => {
    if (args['connectorType'] !== undefined) {
      return { unsupported: 'a connector type filter has no equivalent' };
    }
    const token = isObject(args['idToken']) ? args['idToken']['idToken'] : undefined;
    const group = isObject(args['groupIdToken']) ? args['groupIdToken']['idToken'] : undefined;
    if (
      typeof token !== 'string' ||
      token.length > ID_TAG_MAX ||
      (group !== undefined && (typeof group !== 'string' || group.length > ID_TAG_MAX))
    ) {
      return { unsupported: `an OCPP 1.6 idTag holds at most ${String(ID_TAG_MAX)} characters` };
    }
    return {
      operationId: 'ocppv16_ReserveNow',
      args: defined({
        stationId: args['stationId'],
        connectorId: args['evseId'] ?? 0,
        expiryDate: args['expiryDateTime'],
        idTag: token,
        parentIdTag: group,
        reservationId: args['id'],
      }),
    };
  },
  ocppv21_SendLocalList: (args) => {
    const list = args['localAuthorizationList'];
    const entries: Args[] = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const token = isObject(entry) && isObject(entry['idToken']) ? entry['idToken'] : undefined;
      const value = token?.['idToken'];
      if (typeof value !== 'string' || value.length > ID_TAG_MAX) {
        return { unsupported: `an OCPP 1.6 idTag holds at most ${String(ID_TAG_MAX)} characters` };
      }
      const info = isObject(entry) && isObject(entry['idTokenInfo']) ? entry['idTokenInfo'] : null;
      if (info === null) {
        entries.push({ idTag: value });
        continue;
      }
      const status = text(info['status']);
      if (!['Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'].includes(status)) {
        return { unsupported: `the ${status} token status has no equivalent` };
      }
      const group = isObject(info['groupIdToken']) ? info['groupIdToken']['idToken'] : undefined;
      entries.push({
        idTag: value,
        idTagInfo: defined({
          status,
          expiryDate: info['cacheExpiryDateTime'],
          parentIdTag: typeof group === 'string' ? group : undefined,
        }),
      });
    }
    return {
      operationId: 'ocppv16_SendLocalList',
      args: defined({
        stationId: args['stationId'],
        listVersion: args['versionNumber'],
        updateType: args['updateType'],
        localAuthorizationList: Array.isArray(list) ? entries : undefined,
      }),
    };
  },
};

/** The operationIds of the tools with a translation (tests check each against the catalog). */
export function translatedOperationIds(): string[] {
  return [...Object.keys(translators16To21({})), ...Object.keys(TRANSLATE_21_TO_16)];
}

/**
 * Maps a station command tool call to the station's OCPP version. A tool of
 * the other version becomes its equivalent with translated arguments, or an
 * `unsupported` answer for the model.
 */
export function mapOcppCommand(
  tool: Pick<AiCatalogTool, 'name' | 'operationId' | 'pathTemplate'>,
  args: Args,
  stationVersion: OcppVersion,
  options: MapOptions = {},
): OcppCommandMapping {
  const toolVersion = toolOcppVersion(tool);
  if (toolVersion === null || toolVersion === stationVersion) return { kind: 'match' };
  const prefix = stationVersion === 'ocpp1.6' ? 'ocppv16_' : 'ocppv21_';
  const station = text(args['stationId']);
  const intro = `Station ${station} uses ${ocppVersionLabel(stationVersion)}, but ${tool.name} is an ${ocppVersionLabel(toolVersion)} command.`;
  const translate =
    toolVersion === 'ocpp1.6'
      ? translators16To21(options)[tool.operationId]
      : TRANSLATE_21_TO_16[tool.operationId];
  if (translate === undefined) {
    return {
      kind: 'unsupported',
      message: `${intro} It has no ${ocppVersionLabel(stationVersion)} equivalent. Use only ${prefix} tools for this station.`,
    };
  }
  const result = translate(args);
  if ('unsupported' in result) {
    return {
      kind: 'unsupported',
      message: `${intro} It cannot be translated: ${result.unsupported}. Use only ${prefix} tools for this station.`,
    };
  }
  return { kind: 'mapped', operationId: result.operationId, args: result.args };
}
