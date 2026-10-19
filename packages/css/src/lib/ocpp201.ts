// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP 2.0.1 edge of the simulator. A 2.0.1 station runs the 2.1 message
// builders, and the client passes every CALL and every CALLRESULT it sends
// through these functions, so no 2.1-only field or enum value reaches the CSMS
// (every 2.0.1 object is closed, a real 2.0.1 station never sends them).
// A value with a close 2.0.1 equivalent is mapped, a 2.1-only field is dropped,
// and a value whose meaning cannot be kept (an idToken type 2.0.1 lacks)
// throws instead of being sent with another meaning.

import { isOcpp21OnlyMessage } from '@evtivity/lib/ocpp-version';

/** Whether OCPP 2.0.1 defines the message (every message but the 2.1-only ones). */
export function isOcpp201Action(action: string): boolean {
  return !isOcpp21OnlyMessage(action);
}

/** The 2.0.1 MeasurandEnumType (2.1 adds 31 values). */
export const MEASURANDS_201: readonly string[] = [
  'Current.Export',
  'Current.Import',
  'Current.Offered',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Active.Net',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Net',
  'Energy.Apparent.Net',
  'Energy.Apparent.Import',
  'Energy.Apparent.Export',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Factor',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'SoC',
  'Voltage',
];

/** The 2.0.1 LocationEnumType (2.1 adds Upstream). */
export const LOCATIONS_201: readonly string[] = ['Body', 'Cable', 'EV', 'Inlet', 'Outlet'];

/** The 2.0.1 IdTokenEnumType (2.1 makes the type free text). */
export const ID_TOKEN_TYPES_201: readonly string[] = [
  'Central',
  'eMAID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
];

/** The 2.0.1 ChargingLimitSourceEnumType (2.1 makes the source free text). */
export const CHARGING_LIMIT_SOURCES_201: readonly string[] = ['EMS', 'Other', 'SO', 'CSO'];

/**
 * 2.1 TriggerReasonEnumType values 2.0.1 lacks, with the closest 2.0.1 value:
 * a reached limit is EnergyLimitReached, a changed limit ChargingRateChanged,
 * a running cost update a periodic meter value, the rest a state change.
 */
export const TRIGGER_REASONS_TO_201: Readonly<Record<string, string>> = {
  CostLimitReached: 'EnergyLimitReached',
  SoCLimitReached: 'EnergyLimitReached',
  LimitSet: 'ChargingRateChanged',
  OperationModeChanged: 'ChargingRateChanged',
  RunningCost: 'MeterValuePeriodic',
  TariffChanged: 'ChargingStateChanged',
  TariffNotAccepted: 'ChargingStateChanged',
  TxResumed: 'ChargingStateChanged',
};

/** 2.1 ReasonEnumType values 2.0.1 lacks. */
const STOP_REASONS_TO_201: Readonly<Record<string, string>> = {
  ReqEnergyTransferRejected: 'Other',
};

/** The 2.0.1 limit on StatusInfoType.additionalInfo and MessageContentType.content (2.1: 1024). */
const TEXT_MAX_201 = 512;

/** The 2.0.1 limit on SignedMeterValueType.signedMeterData (2.1: 32768). */
const SIGNED_METER_DATA_MAX_201 = 2500;

/** The 2.0.1 limit on IdTokenType.idToken (2.1: 255). */
const ID_TOKEN_MAX_201 = 36;

const SCHEDULE_FIELDS_21 = [
  'limitAtSoC',
  'powerTolerance',
  'signatureId',
  'digestValue',
  'useLocalTime',
  'randomizedDelay',
  'absolutePriceSchedule',
  'priceLevelSchedule',
];

const PERIOD_FIELDS_21 = [
  'limit_L2',
  'limit_L3',
  'dischargeLimit',
  'dischargeLimit_L2',
  'dischargeLimit_L3',
  'setpoint',
  'setpoint_L2',
  'setpoint_L3',
  'setpointReactive',
  'setpointReactive_L2',
  'setpointReactive_L3',
  'preconditioningRequest',
  'evseSleep',
  'v2xBaseline',
  'operationMode',
  'v2xFreqWattCurve',
  'v2xSignalWattCurve',
];

const PROFILE_FIELDS_21 = [
  'maxOfflineDuration',
  'invalidAfterOfflineDuration',
  'dynUpdateInterval',
  'dynUpdateTime',
  'priceScheduleSignature',
];

const PROFILE_PURPOSES_21 = new Set(['PriorityCharging', 'LocalGeneration']);
const MESSAGE_STATES_21 = new Set(['Suspended', 'Discharging']);
const MONITOR_TYPES_21 = new Set(['TargetDelta', 'TargetDeltaRelative']);

/** A station message that cannot be sent to an OCPP 2.0.1 CSMS without changing its meaning. */
export class Ocpp201StationError extends Error {
  constructor(action: string, reason: string) {
    super(`${action} cannot be sent as OCPP 2.0.1: ${reason}`);
    this.name = 'Ocpp201StationError';
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v != null && !Array.isArray(v);
}

function objects(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function drop(o: Obj, fields: readonly string[]): void {
  for (const f of fields) Reflect.deleteProperty(o, f);
}

/** Cut every statusInfo and attributeStatusInfo additionalInfo to the 2.0.1 length. */
function cutStatusInfo(v: unknown): void {
  if (Array.isArray(v)) {
    for (const item of v) cutStatusInfo(item);
    return;
  }
  if (!isObj(v)) return;
  for (const [key, child] of Object.entries(v)) {
    if ((key === 'statusInfo' || key === 'attributeStatusInfo') && isObj(child)) {
      const info = child['additionalInfo'];
      if (typeof info === 'string' && info.length > TEXT_MAX_201) {
        child['additionalInfo'] = info.slice(0, TEXT_MAX_201);
      }
    }
    cutStatusInfo(child);
  }
}

function checkIdToken(action: string, token: unknown): void {
  if (!isObj(token)) return;
  const type = token['type'];
  if (typeof type === 'string' && !ID_TOKEN_TYPES_201.includes(type)) {
    throw new Ocpp201StationError(action, `idToken type ${type} does not exist in OCPP 2.0.1`);
  }
  const id = token['idToken'];
  if (typeof id === 'string' && id.length > ID_TOKEN_MAX_201) {
    throw new Ocpp201StationError(action, `idToken is longer than ${String(ID_TOKEN_MAX_201)}`);
  }
}

function checkLimitSource(action: string, source: unknown): void {
  if (typeof source === 'string' && !CHARGING_LIMIT_SOURCES_201.includes(source)) {
    throw new Ocpp201StationError(action, `chargingLimitSource ${source} does not exist in 2.0.1`);
  }
}

/** Keep the sampled values 2.0.1 can carry; returns the meter values that keep one. */
function fitMeterValues(meterValues: unknown): Obj[] {
  const kept: Obj[] = [];
  for (const mv of objects(meterValues)) {
    const samples = objects(mv['sampledValue']).filter((sv) => {
      const measurand = sv['measurand'];
      const location = sv['location'];
      return (
        (measurand == null || MEASURANDS_201.includes(measurand as string)) &&
        (location == null || LOCATIONS_201.includes(location as string))
      );
    });
    for (const sv of samples) {
      const signed = sv['signedMeterValue'];
      if (!isObj(signed)) continue;
      const data = signed['signedMeterData'];
      // 2.0.1 requires signingMethod and publicKey (an empty key is allowed).
      if (typeof data !== 'string' || data.length > SIGNED_METER_DATA_MAX_201) {
        delete sv['signedMeterValue'];
        continue;
      }
      if (typeof signed['signingMethod'] !== 'string') signed['signingMethod'] = '';
      if (typeof signed['publicKey'] !== 'string') signed['publicKey'] = '';
    }
    if (samples.length > 0) kept.push({ ...mv, sampledValue: samples });
  }
  return kept;
}

function fitSchedule(action: string, schedule: Obj): void {
  drop(schedule, SCHEDULE_FIELDS_21);
  for (const period of objects(schedule['chargingSchedulePeriod'])) {
    drop(period, PERIOD_FIELDS_21);
    if (typeof period['limit'] !== 'number') {
      throw new Ocpp201StationError(action, 'a charging schedule period without a limit');
    }
  }
}

function fitProfiles(action: string, profiles: unknown): Obj[] {
  return objects(profiles).filter((profile) => {
    if (
      PROFILE_PURPOSES_21.has(profile['chargingProfilePurpose'] as string) ||
      profile['chargingProfileKind'] === 'Dynamic'
    ) {
      return false;
    }
    drop(profile, PROFILE_FIELDS_21);
    for (const s of objects(profile['chargingSchedule'])) fitSchedule(action, s);
    return true;
  });
}

function fitMessageInfo(messages: unknown): Obj[] {
  return objects(messages).filter((m) => {
    delete m['messageExtra'];
    const message = m['message'];
    if (MESSAGE_STATES_21.has(m['state'] as string)) return false;
    if (isObj(message)) {
      if (message['format'] === 'QRCODE') return false;
      const content = message['content'];
      if (typeof content === 'string' && content.length > TEXT_MAX_201) {
        message['content'] = content.slice(0, TEXT_MAX_201);
      }
    }
    return true;
  });
}

function fitTransactionEvent(p: Obj): void {
  drop(p, ['costDetails', 'preconditioningStatus', 'evseSleep']);
  const trigger = p['triggerReason'];
  if (typeof trigger === 'string' && TRIGGER_REASONS_TO_201[trigger] != null) {
    p['triggerReason'] = TRIGGER_REASONS_TO_201[trigger];
  }
  const info = p['transactionInfo'];
  if (isObj(info)) {
    drop(info, ['operationMode', 'tariffId', 'transactionLimit']);
    const reason = info['stoppedReason'];
    if (typeof reason === 'string' && STOP_REASONS_TO_201[reason] != null) {
      info['stoppedReason'] = STOP_REASONS_TO_201[reason];
    }
  }
  checkIdToken('TransactionEvent', p['idToken']);
  if (p['meterValue'] != null) {
    const kept = fitMeterValues(p['meterValue']);
    if (kept.length > 0) p['meterValue'] = kept;
    else delete p['meterValue'];
  }
}

/**
 * A station request (CALL) in its OCPP 2.0.1 form, or null when nothing of it
 * exists in 2.0.1 (a MeterValues whose every sample is 2.1-only, a profile report
 * of 2.1-only profiles): the client then sends nothing.
 */
export function toOcpp201StationRequest(action: string, payload: Obj): Obj | null {
  const p = structuredClone(payload);
  cutStatusInfo(p);
  switch (action) {
    case 'TransactionEvent':
      fitTransactionEvent(p);
      break;
    case 'MeterValues': {
      const kept = fitMeterValues(p['meterValue']);
      if (kept.length === 0) return null;
      p['meterValue'] = kept;
      break;
    }
    case 'Authorize':
      checkIdToken(action, p['idToken']);
      break;
    case 'NotifyReport':
      for (const item of objects(p['reportData'])) {
        const chars = item['variableCharacteristics'];
        if (isObj(chars)) delete chars['maxElements'];
      }
      break;
    case 'NotifyMonitoringReport':
      for (const monitor of objects(p['monitor'])) {
        const kept = objects(monitor['variableMonitoring']).filter(
          (vm) => !MONITOR_TYPES_21.has(vm['type'] as string),
        );
        for (const vm of kept) delete vm['eventNotificationType'];
        monitor['variableMonitoring'] = kept;
      }
      p['monitor'] = objects(p['monitor']).filter(
        (m) => objects(m['variableMonitoring']).length > 0,
      );
      if ((p['monitor'] as unknown[]).length === 0) delete p['monitor'];
      break;
    case 'NotifyEvent':
      for (const event of objects(p['eventData'])) delete event['severity'];
      break;
    case 'NotifyEVChargingNeeds': {
      delete p['timestamp'];
      const needs = p['chargingNeeds'];
      if (isObj(needs)) {
        drop(needs, [
          'derChargingParameters',
          'evEnergyOffer',
          'v2xChargingParameters',
          'availableEnergyTransfer',
          'controlMode',
          'mobilityNeedsMode',
        ]);
        const mode = needs['requestedEnergyTransfer'];
        if (
          typeof mode === 'string' &&
          !['DC', 'AC_single_phase', 'AC_two_phase', 'AC_three_phase'].includes(mode)
        ) {
          throw new Ocpp201StationError(action, `energy transfer ${mode} does not exist in 2.0.1`);
        }
      }
      break;
    }
    case 'NotifyEVChargingSchedule':
      drop(p, ['selectedChargingScheduleId', 'powerToleranceAcceptance']);
      if (isObj(p['chargingSchedule'])) fitSchedule(action, p['chargingSchedule']);
      break;
    case 'NotifyChargingLimit': {
      const limit = p['chargingLimit'];
      if (isObj(limit)) {
        delete limit['isLocalGeneration'];
        checkLimitSource(action, limit['chargingLimitSource']);
      }
      for (const s of objects(p['chargingSchedule'])) fitSchedule(action, s);
      break;
    }
    case 'ClearedChargingLimit':
      checkLimitSource(action, p['chargingLimitSource']);
      break;
    case 'ReportChargingProfiles': {
      checkLimitSource(action, p['chargingLimitSource']);
      const kept = fitProfiles(action, p['chargingProfile']);
      if (kept.length === 0) return null;
      p['chargingProfile'] = kept;
      break;
    }
    case 'NotifyDisplayMessages':
      if (p['messageInfo'] != null) {
        const kept = fitMessageInfo(p['messageInfo']);
        if (kept.length > 0) p['messageInfo'] = kept;
        else delete p['messageInfo'];
      }
      break;
    case 'FirmwareStatusNotification':
    case 'LogStatusNotification':
    case 'PublishFirmwareStatusNotification':
      delete p['statusInfo'];
      break;
    case 'Get15118EVCertificate':
      drop(p, ['maximumContractCertificateChains', 'prioritizedEMAIDs']);
      break;
    case 'SignCertificate':
      drop(p, ['hashRootCertificate', 'requestId']);
      if (p['certificateType'] === 'V2G20Certificate') {
        throw new Ocpp201StationError(action, 'V2G20Certificate does not exist in 2.0.1');
      }
      break;
    case 'ReservationStatusUpdate':
      // NoTransaction (2.1): the reservation ended without a transaction, which 2.0.1 reports as Expired.
      if (p['reservationUpdateStatus'] === 'NoTransaction')
        p['reservationUpdateStatus'] = 'Expired';
      break;
    default:
      break;
  }
  return p;
}

/** A station reply (CALLRESULT) to a CSMS command in its OCPP 2.0.1 form. */
export function toOcpp201StationResponse(action: string, payload: Obj): Obj {
  const p = structuredClone(payload);
  cutStatusInfo(p);
  switch (action) {
    case 'GetCompositeSchedule': {
      const schedule = p['schedule'];
      if (isObj(schedule)) {
        for (const period of objects(schedule['chargingSchedulePeriod'])) {
          drop(period, PERIOD_FIELDS_21);
        }
      }
      break;
    }
    case 'ClearDisplayMessage':
      // 2.0.1 ClearMessageStatusEnumType: Accepted, Unknown.
      if (p['status'] === 'Rejected') p['status'] = 'Unknown';
      break;
    case 'SetDisplayMessage':
      if (p['status'] === 'LanguageNotSupported') p['status'] = 'Rejected';
      break;
    case 'GetInstalledCertificateIds': {
      const chain = objects(p['certificateHashDataChain']).filter(
        (c) => c['certificateType'] !== 'OEMRootCertificate',
      );
      if (chain.length > 0) {
        p['certificateHashDataChain'] = chain;
      } else if (p['certificateHashDataChain'] != null) {
        delete p['certificateHashDataChain'];
        p['status'] = 'NotFound';
      }
      break;
    }
    default:
      break;
  }
  return p;
}
