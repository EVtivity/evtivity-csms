// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A one-line summary of a logged OCPP message for the live OCPP window, from
 * its action, type and payload. Generic for OCPP 1.6 and 2.x: the words are
 * the protocol's own values (event types, statuses, models), so they stay
 * untranslated; the caller formats the power for the UI language.
 */

export const OCPP_CALL = 2;
export const OCPP_CALLRESULT = 3;
export const OCPP_CALLERROR = 4;

export interface OcppMessageInput {
  action: string | null;
  messageType: number;
  payload?: unknown;
  errorCode: string | null;
  errorDescription: string | null;
}

export interface OcppMessageSummary {
  /** Short protocol words, in order, such as `Updated`, `Charging`. */
  parts: string[];
  /** Active power in kW from a meter value in the payload, else null. */
  powerKw: number | null;
  /** A routine keep-alive (Heartbeat): shown dimmed. */
  dim: boolean;
  /** A CALLERROR or a refusal: shown in the error color. */
  error: boolean;
}

/** Longest error description shown on the line; the payload holds the rest. */
export const ERROR_DESCRIPTION_MAX = 60;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The kW of one sampled value: 2.x `unitOfMeasure { unit, multiplier }`, 1.6 `unit`. */
function sampleKw(sample: Obj): number | null {
  const value = num(sample['value']);
  if (value == null) return null;
  const uom = obj(sample['unitOfMeasure']);
  const unit = str(uom?.['unit']) ?? str(sample['unit']) ?? 'W';
  const multiplier = num(uom?.['multiplier']) ?? 0;
  const scaled = value * 10 ** multiplier;
  if (unit === 'kW') return scaled;
  if (unit === 'W') return scaled / 1000;
  return null;
}

/**
 * Active import power of the newest meter value: the total sample when there
 * is one, else the sum of the phase samples.
 */
export function meterPowerKw(meterValues: unknown): number | null {
  if (!Array.isArray(meterValues)) return null;
  for (let i = meterValues.length - 1; i >= 0; i -= 1) {
    const samples = obj(meterValues[i])?.['sampledValue'];
    if (!Array.isArray(samples)) continue;
    const power = samples
      .map(obj)
      .filter((s): s is Obj => s != null && s['measurand'] === 'Power.Active.Import');
    if (power.length === 0) continue;
    const total = power.find((s) => str(s['phase']) == null);
    if (total != null) return sampleKw(total);
    let sum = 0;
    for (const s of power) {
      const kw = sampleKw(s);
      if (kw == null) return null;
      sum += kw;
    }
    return sum;
  }
  return null;
}

function evseLabel(evseId: unknown, connectorId: unknown): string | null {
  const evse = num(evseId);
  const connector = num(connectorId);
  if (evse == null && connector == null) return null;
  if (evse == null) return `#${String(connector)}`;
  return connector == null ? `EVSE ${String(evse)}` : `EVSE ${String(evse)}/${String(connector)}`;
}

function push(parts: string[], value: string | null): void {
  if (value != null) parts.push(value);
}

function callParts(action: string, p: Obj): { parts: string[]; powerKw: number | null } {
  const parts: string[] = [];
  let powerKw: number | null = null;
  switch (action) {
    case 'TransactionEvent': {
      push(parts, str(p['eventType']));
      push(parts, str(obj(p['transactionInfo'])?.['chargingState']));
      push(parts, str(p['triggerReason']));
      powerKw = meterPowerKw(p['meterValue']);
      break;
    }
    case 'StatusNotification': {
      // 2.x connectorStatus with evseId; 1.6 status with connectorId and errorCode.
      push(parts, evseLabel(p['evseId'], p['connectorId']));
      push(parts, str(p['connectorStatus']) ?? str(p['status']));
      const errorCode = str(p['errorCode']);
      if (errorCode != null && errorCode !== 'NoError') parts.push(errorCode);
      break;
    }
    case 'MeterValues': {
      push(parts, evseLabel(p['evseId'], p['connectorId']));
      powerKw = meterPowerKw(p['meterValue']);
      break;
    }
    case 'BootNotification': {
      const station = obj(p['chargingStation']);
      push(parts, str(station?.['vendorName']) ?? str(p['chargePointVendor']));
      push(parts, str(station?.['model']) ?? str(p['chargePointModel']));
      push(parts, str(p['reason']));
      break;
    }
    case 'StartTransaction':
      push(parts, evseLabel(null, p['connectorId']));
      break;
    case 'StopTransaction':
      push(parts, str(p['reason']));
      break;
    default:
      // Commands the CSMS sends usually carry a type (Reset, TriggerMessage).
      push(parts, str(p['type']) ?? str(p['requestedMessage']));
  }
  return { parts, powerKw };
}

/** The status a response carries: `status`, or a token or registration status. */
function resultStatus(p: Obj): string | null {
  return (
    str(p['status']) ??
    str(obj(p['idTokenInfo'])?.['status']) ??
    str(obj(p['idTagInfo'])?.['status'])
  );
}

const REFUSED_STATUSES = new Set(['Rejected', 'Invalid', 'Blocked', 'Expired', 'Faulted']);

export function summarizeOcppMessage(message: OcppMessageInput): OcppMessageSummary {
  const dim = message.action === 'Heartbeat';
  if (message.messageType === OCPP_CALLERROR) {
    const parts: string[] = [];
    push(parts, message.errorCode);
    const description = str(message.errorDescription);
    if (description != null) {
      parts.push(
        description.length > ERROR_DESCRIPTION_MAX
          ? `${description.slice(0, ERROR_DESCRIPTION_MAX - 1)}…`
          : description,
      );
    }
    return { parts, powerKw: null, dim: false, error: true };
  }
  const payload = obj(message.payload) ?? {};
  if (message.messageType === OCPP_CALLRESULT) {
    const status = resultStatus(payload);
    return {
      parts: status != null ? [status] : [],
      powerKw: null,
      dim,
      error: status != null && REFUSED_STATUSES.has(status),
    };
  }
  if (message.action == null) return { parts: [], powerKw: null, dim, error: false };
  const { parts, powerKw } = callParts(message.action, payload);
  return { parts, powerKw, dim, error: false };
}
