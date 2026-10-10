// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys, TFunction } from 'i18next';

/**
 * The sentence a confirmation card leads with: what the change does, in the
 * user's language, such as "Reset station IOCHARGER-002 (when idle)". The
 * common station commands get their own sentence (OCPP 1.6 and 2.1 tools
 * alike), any other OCPP command "Send <command> to station <id>", and every
 * other tool the method template with its humanized name.
 */

export interface ConfirmSummaryInput {
  name: string;
  method: string;
  path: string;
  arguments: Record<string, unknown>;
}

/** `update_station` reads "update station". */
export function humanToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim();
}

const OCPP_TOOL = /^ocppv(?:16|21)_(.+)$/;
const OCPP_PATH = /^\/v1\/ocpp\/commands\/v(?:16|21)\/([A-Za-z0-9]+)$/;

/** OCPP 2.1 ResetEnumType and OCPP 1.6 Reset types. */
const RESET_TYPE_KEYS: Record<string, ParseKeys> = {
  Immediate: 'ai.confirmAction.resetType.Immediate',
  OnIdle: 'ai.confirmAction.resetType.OnIdle',
  ImmediateAndResume: 'ai.confirmAction.resetType.ImmediateAndResume',
  Hard: 'ai.confirmAction.resetType.Hard',
  Soft: 'ai.confirmAction.resetType.Soft',
};

/** OperationalStatusEnumType (2.1) and AvailabilityType (1.6). */
const AVAILABILITY_KEYS: Record<string, ParseKeys> = {
  Operative: 'ai.confirmAction.availabilityStatus.Operative',
  Inoperative: 'ai.confirmAction.availabilityStatus.Inoperative',
};

const METHOD_KEYS: Record<string, ParseKeys> = {
  POST: 'ai.confirmSummary.POST',
  PUT: 'ai.confirmSummary.PUT',
  PATCH: 'ai.confirmSummary.PATCH',
  DELETE: 'ai.confirmSummary.DELETE',
};

/** A scalar argument as display text; undefined when absent or not a scalar. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A positive id (EVSE or connector); 0 or absent addresses the whole station. */
function positiveId(value: unknown): string | undefined {
  return typeof value === 'number' && value > 0 ? String(value) : undefined;
}

/** The EVSE and connector of an OCPP 2.1 `evse` object (`{ id, connectorId? }`). */
function evseObject(value: unknown): { evse: string | undefined; connector: string | undefined } {
  if (value == null || typeof value !== 'object') return { evse: undefined, connector: undefined };
  const obj = value as Record<string, unknown>;
  return { evse: positiveId(obj['id']), connector: positiveId(obj['connectorId']) };
}

/** "EVSE 1", "connector 2" or "EVSE 1, connector 2"; undefined for the whole station. */
function target(t: TFunction, evse?: string, connector?: string): string | undefined {
  if (evse !== undefined && connector !== undefined) {
    return t('ai.confirmAction.target.evseConnector', { evse, connector });
  }
  if (evse !== undefined) return t('ai.confirmAction.target.evse', { evse });
  if (connector !== undefined) return t('ai.confirmAction.target.connector', { connector });
  return undefined;
}

function resetSentence(
  t: TFunction,
  station: string,
  args: Record<string, unknown>,
): string | undefined {
  const typeKey = RESET_TYPE_KEYS[text(args['type']) ?? ''];
  const mode = typeKey !== undefined ? t(typeKey) : undefined;
  const where = target(t, positiveId(args['evseId']));
  if (where !== undefined) {
    return mode !== undefined
      ? t('ai.confirmAction.resetAtMode', { station, target: where, mode })
      : t('ai.confirmAction.resetAt', { station, target: where });
  }
  return mode !== undefined
    ? t('ai.confirmAction.resetMode', { station, mode })
    : t('ai.confirmAction.reset', { station });
}

function availabilitySentence(
  t: TFunction,
  station: string,
  args: Record<string, unknown>,
): string | undefined {
  const statusKey = AVAILABILITY_KEYS[text(args['operationalStatus']) ?? text(args['type']) ?? ''];
  if (statusKey === undefined) return undefined;
  const status = t(statusKey);
  const { evse, connector } = evseObject(args['evse']);
  const where = target(t, evse, connector ?? positiveId(args['connectorId']));
  return where !== undefined
    ? t('ai.confirmAction.availabilityAt', { station, target: where, status })
    : t('ai.confirmAction.availability', { station, status });
}

/** The sentence for a known station command, or undefined. */
function stationCommand(
  t: TFunction,
  command: string,
  station: string,
  args: Record<string, unknown>,
): string | undefined {
  const where = target(t, positiveId(args['evseId']), positiveId(args['connectorId']));
  switch (command) {
    case 'reset':
      return resetSentence(t, station, args);
    case 'change_availability':
      return availabilitySentence(t, station, args);
    case 'unlock_connector':
      return where !== undefined
        ? t('ai.confirmAction.unlockAt', { station, target: where })
        : t('ai.confirmAction.unlock', { station });
    case 'remote_start_transaction':
    case 'request_start_transaction':
      return where !== undefined
        ? t('ai.confirmAction.startAt', { station, target: where })
        : t('ai.confirmAction.start', { station });
    case 'remote_stop_transaction':
    case 'request_stop_transaction': {
      const transaction = text(args['transactionId']);
      return transaction !== undefined
        ? t('ai.confirmAction.stop', { station, transaction })
        : t('ai.confirmAction.stopAny', { station });
    }
    case 'set_charging_profile':
      return where !== undefined
        ? t('ai.confirmAction.chargingProfileAt', { station, target: where })
        : t('ai.confirmAction.chargingProfile', { station });
    default:
      return undefined;
  }
}

export function confirmSummary(t: TFunction, input: ConfirmSummaryInput): string {
  const command = OCPP_TOOL.exec(input.name)?.[1];
  const station = text(input.arguments['stationId']);
  if (command !== undefined && station !== undefined) {
    const sentence = stationCommand(t, command, station, input.arguments);
    if (sentence !== undefined) return sentence;
    const action = OCPP_PATH.exec(input.path)?.[1];
    if (action !== undefined)
      return t('ai.confirmAction.ocppCommand', { command: action, station });
  }
  const methodKey = METHOD_KEYS[input.method] ?? 'ai.confirmSummary.POST';
  return t(methodKey, { tool: humanToolName(input.name) });
}
