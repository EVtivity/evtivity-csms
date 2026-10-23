// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station data plans: two sets of OCPP station settings, Wi-Fi or wired (the
// default) and Cellular, each with AC and DC values for the readings while
// charging. Browser-safe: the CSMS imports the plan ids, keys and checks.

import { isOcpp2x } from './ocpp-version.js';

export const DATA_PLANS = ['wifi_or_wired', 'cellular'] as const;
export type DataPlan = (typeof DATA_PLANS)[number];
export const DEFAULT_DATA_PLAN: DataPlan = 'wifi_or_wired';

/** Where a station's effective plan comes from, in precedence order. */
export const DATA_PLAN_SOURCES = ['station', 'sim', 'site', 'default'] as const;
export type DataPlanSource = (typeof DATA_PLAN_SOURCES)[number];

export const CHARGING_KINDS = ['ac', 'dc'] as const;
export type ChargingKind = (typeof CHARGING_KINDS)[number];

/** The `cache_invalidate` message kind that tells OCPP pods a station's plan changed. */
export const STATION_DATA_PLAN_INVALIDATION_KIND = 'station_data_plan';

/**
 * The `cache_invalidate` message that tells the OCPP pod holding a station
 * to re-read its data plan and re-arm its ping and idle timers. Carries the
 * OCPP identity, the key of the connection registry.
 */
export function stationDataPlanInvalidationPayload(stationOcppId: string): string {
  return JSON.stringify({ kind: STATION_DATA_PLAN_INVALIDATION_KIND, stationId: stationOcppId });
}

/** The OCPP identity of a station data plan invalidation, or null for any other message. */
export function parseStationDataPlanInvalidation(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg == null) return null;
  const { kind, stationId } = msg as { kind?: unknown; stationId?: unknown };
  if (kind !== STATION_DATA_PLAN_INVALIDATION_KIND) return null;
  return typeof stationId === 'string' && stationId !== '' ? stationId : null;
}

export function isDataPlan(value: unknown): value is DataPlan {
  return typeof value === 'string' && (DATA_PLANS as readonly string[]).includes(value);
}

/**
 * The effective plan: the station's operator choice, else Cellular for a
 * confirmed SIM on the station, else the site's plan, else Wi-Fi or wired.
 * `effectiveDataPlanSql` in @evtivity/database is the SQL twin.
 */
export function resolveDataPlan(input: {
  stationPlan: DataPlan | null | undefined;
  hasConfirmedSim: boolean;
  sitePlan: DataPlan | null | undefined;
}): { plan: DataPlan; source: DataPlanSource } {
  if (input.stationPlan != null) return { plan: input.stationPlan, source: 'station' };
  if (input.hasConfirmedSim) return { plan: 'cellular', source: 'sim' };
  if (input.sitePlan != null) return { plan: input.sitePlan, source: 'site' };
  return { plan: DEFAULT_DATA_PLAN, source: 'default' };
}

export interface ChargingReadings {
  /** TxUpdatedInterval / MeterValueSampleInterval, seconds. */
  meterValueInterval: number;
  /** TxUpdatedMeasurands / MeterValuesSampledData, comma separated. */
  sampledMeasurands: string;
}

export interface DataPlanValues {
  heartbeatInterval: number;
  csmsPingInterval: number;
  /** Idle (clock-aligned) reading interval, seconds; 0 turns idle readings off. */
  clockAlignedInterval: number;
  alignedMeasurands: string;
  txEndedMeasurands: string;
  ac: ChargingReadings;
  dc: ChargingReadings;
}

export const DATA_PLAN_DEFAULTS: Readonly<Record<DataPlan, DataPlanValues>> = {
  wifi_or_wired: {
    heartbeatInterval: 900,
    csmsPingInterval: 120,
    clockAlignedInterval: 900,
    alignedMeasurands: 'Energy.Active.Import.Register',
    txEndedMeasurands: 'Energy.Active.Import.Register',
    ac: {
      meterValueInterval: 60,
      sampledMeasurands: 'Energy.Active.Import.Register,Power.Active.Import,Current.Import',
    },
    dc: {
      meterValueInterval: 30,
      sampledMeasurands: 'Energy.Active.Import.Register,Power.Active.Import,Current.Import,SoC',
    },
  },
  cellular: {
    heartbeatInterval: 3600,
    csmsPingInterval: 240,
    clockAlignedInterval: 0,
    alignedMeasurands: 'Energy.Active.Import.Register',
    txEndedMeasurands: 'Energy.Active.Import.Register',
    ac: {
      meterValueInterval: 300,
      sampledMeasurands: 'Energy.Active.Import.Register,Power.Active.Import',
    },
    dc: {
      meterValueInterval: 60,
      sampledMeasurands: 'Energy.Active.Import.Register,Power.Active.Import,SoC',
    },
  },
};

/** The settings key of each plan value. Wi-Fi or wired keeps the original `ocpp.*` keys. */
export interface DataPlanSettingKeys {
  heartbeatInterval: string;
  csmsPingInterval: string;
  clockAlignedInterval: string;
  alignedMeasurands: string;
  txEndedMeasurands: string;
  acMeterValueInterval: string;
  acSampledMeasurands: string;
  dcMeterValueInterval: string;
  dcSampledMeasurands: string;
}

export function dataPlanSettingKeys(plan: DataPlan): DataPlanSettingKeys {
  const p = plan === 'cellular' ? 'ocpp.cellular.' : 'ocpp.';
  return {
    heartbeatInterval: `${p}heartbeatInterval`,
    csmsPingInterval: `${p}csmsPingInterval`,
    clockAlignedInterval: `${p}clockAlignedInterval`,
    alignedMeasurands: `${p}alignedMeasurands`,
    txEndedMeasurands: `${p}txEndedMeasurands`,
    acMeterValueInterval: `${p}meterValueInterval`,
    acSampledMeasurands: `${p}sampledMeasurands`,
    dcMeterValueInterval: `${p}dc.meterValueInterval`,
    dcSampledMeasurands: `${p}dc.sampledMeasurands`,
  };
}

/** Builds plan values from settings rows, falling back to the shipped value per key. */
export function dataPlanValuesFromSettings(
  plan: DataPlan,
  rows: ReadonlyMap<string, unknown>,
): DataPlanValues {
  const keys = dataPlanSettingKeys(plan);
  const d = DATA_PLAN_DEFAULTS[plan];
  // A stored value out of range (written to the database directly or by a
  // seed file) takes the shipped value, so a 0 ping interval cannot close
  // every station.
  const num = (key: string, fallback: number): number => {
    const v = rows.get(key);
    return typeof v === 'number' && validateDataPlanSetting(key, v) == null ? v : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const v = rows.get(key);
    return typeof v === 'string' && validateDataPlanSetting(key, v) == null
      ? normalizeMeasurandList(v)
      : fallback;
  };
  return {
    heartbeatInterval: num(keys.heartbeatInterval, d.heartbeatInterval),
    csmsPingInterval: num(keys.csmsPingInterval, d.csmsPingInterval),
    clockAlignedInterval: num(keys.clockAlignedInterval, d.clockAlignedInterval),
    alignedMeasurands: str(keys.alignedMeasurands, d.alignedMeasurands),
    txEndedMeasurands: str(keys.txEndedMeasurands, d.txEndedMeasurands),
    ac: {
      meterValueInterval: num(keys.acMeterValueInterval, d.ac.meterValueInterval),
      sampledMeasurands: str(keys.acSampledMeasurands, d.ac.sampledMeasurands),
    },
    dc: {
      meterValueInterval: num(keys.dcMeterValueInterval, d.dc.meterValueInterval),
      sampledMeasurands: str(keys.dcSampledMeasurands, d.dc.sampledMeasurands),
    },
  };
}

// --- Measurands ---

/** OCPP 1.6 Measurand values (MeterValues.json). */
export const OCPP16_MEASURANDS: readonly string[] = [
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'Power.Factor',
  'Current.Import',
  'Current.Export',
  'Current.Offered',
  'Voltage',
  'Frequency',
  'Temperature',
  'SoC',
  'RPM',
];

/** OCPP 2.0.1 MeasurandEnumType. The OCPP package tests it against the generated enum. */
export const OCPP201_MEASURANDS: readonly string[] = [
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

/** OCPP 2.1 MeasurandEnumType. The OCPP package tests it against the generated enum. */
export const OCPP21_MEASURANDS: readonly string[] = [
  'Current.Export',
  'Current.Export.Offered',
  'Current.Export.Minimum',
  'Current.Import',
  'Current.Import.Offered',
  'Current.Import.Minimum',
  'Current.Offered',
  'Display.PresentSOC',
  'Display.MinimumSOC',
  'Display.TargetSOC',
  'Display.MaximumSOC',
  'Display.RemainingTimeToMinimumSOC',
  'Display.RemainingTimeToTargetSOC',
  'Display.RemainingTimeToMaximumSOC',
  'Display.ChargingComplete',
  'Display.BatteryEnergyCapacity',
  'Display.InletHot',
  'Energy.Active.Export.Interval',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Interval',
  'Energy.Active.Import.Register',
  'Energy.Active.Import.CableLoss',
  'Energy.Active.Import.LocalGeneration.Register',
  'Energy.Active.Net',
  'Energy.Active.Setpoint.Interval',
  'Energy.Apparent.Export',
  'Energy.Apparent.Import',
  'Energy.Apparent.Net',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Import.Register',
  'Energy.Reactive.Net',
  'EnergyRequest.Target',
  'EnergyRequest.Minimum',
  'EnergyRequest.Maximum',
  'EnergyRequest.Minimum.V2X',
  'EnergyRequest.Maximum.V2X',
  'EnergyRequest.Bulk',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Active.Setpoint',
  'Power.Active.Residual',
  'Power.Export.Minimum',
  'Power.Export.Offered',
  'Power.Factor',
  'Power.Import.Offered',
  'Power.Import.Minimum',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'SoC',
  'Voltage',
  'Voltage.Minimum',
  'Voltage.Maximum',
];

const KNOWN_MEASURANDS: ReadonlySet<string> = new Set([...OCPP16_MEASURANDS, ...OCPP21_MEASURANDS]);
const OCPP21_SET: ReadonlySet<string> = new Set(OCPP21_MEASURANDS);
const OCPP201_SET: ReadonlySet<string> = new Set(OCPP201_MEASURANDS);
const OCPP16_SET: ReadonlySet<string> = new Set(OCPP16_MEASURANDS);

/** A measurand list with each item trimmed, as stored and sent. */
export function normalizeMeasurandList(csv: string): string {
  return csv
    .split(',')
    .map((m) => m.trim())
    .join(',');
}

/** The measurands of a list a station of this protocol knows, in list order. */
export function measurandsForProtocol(csv: string, protocol: string | null | undefined): string {
  const allowed =
    protocol === 'ocpp1.6' ? OCPP16_SET : protocol === 'ocpp2.0.1' ? OCPP201_SET : OCPP21_SET;
  return csv
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '' && allowed.has(m))
    .join(',');
}

// --- Validation ---

const INTERVAL_RANGES = {
  heartbeatInterval: { min: 30, max: 86400, zero: false },
  csmsPingInterval: { min: 30, max: 3600, zero: false },
  clockAlignedInterval: { min: 60, max: 86400, zero: true },
  meterValueInterval: { min: 5, max: 3600, zero: false },
} as const;

type IntervalField = keyof typeof INTERVAL_RANGES;

interface DataPlanKeyInfo {
  plan: DataPlan;
  field: IntervalField | 'measurands';
}

const DATA_PLAN_KEY_INFO: ReadonlyMap<string, DataPlanKeyInfo> = new Map(
  DATA_PLANS.flatMap((plan): [string, DataPlanKeyInfo][] => {
    const k = dataPlanSettingKeys(plan);
    return [
      [k.heartbeatInterval, { plan, field: 'heartbeatInterval' }],
      [k.csmsPingInterval, { plan, field: 'csmsPingInterval' }],
      [k.clockAlignedInterval, { plan, field: 'clockAlignedInterval' }],
      [k.acMeterValueInterval, { plan, field: 'meterValueInterval' }],
      [k.dcMeterValueInterval, { plan, field: 'meterValueInterval' }],
      [k.alignedMeasurands, { plan, field: 'measurands' }],
      [k.txEndedMeasurands, { plan, field: 'measurands' }],
      [k.acSampledMeasurands, { plan, field: 'measurands' }],
      [k.dcSampledMeasurands, { plan, field: 'measurands' }],
    ];
  }),
);

/** Every settings key of both plans. */
export const DATA_PLAN_SETTING_KEYS: readonly string[] = [...DATA_PLAN_KEY_INFO.keys()];

export function isDataPlanSettingKey(key: string): boolean {
  return DATA_PLAN_KEY_INFO.has(key);
}

/** The range text of an interval key, for messages and help text. */
export function dataPlanIntervalRange(field: IntervalField): {
  min: number;
  max: number;
  zero: boolean;
} {
  return INTERVAL_RANGES[field];
}

/**
 * Checks a value for a data plan settings key. Returns null when valid (or
 * when the key is not a data plan key), else the error message.
 */
export function validateDataPlanSetting(key: string, value: unknown): string | null {
  const info = DATA_PLAN_KEY_INFO.get(key);
  if (info == null) return null;
  if (info.field === 'measurands') {
    if (typeof value !== 'string') return `${key} must be a comma-separated list of measurands`;
    const items = value.split(',').map((m) => m.trim());
    if (items.length === 0 || items.some((m) => m === '')) {
      return `${key} must list at least one measurand, separated by commas`;
    }
    const unknown = items.filter((m) => !KNOWN_MEASURANDS.has(m));
    if (unknown.length > 0) return `${key} has unknown measurands: ${unknown.join(', ')}`;
    return null;
  }
  const range = INTERVAL_RANGES[info.field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${key} must be a whole number of seconds`;
  }
  if (range.zero && value === 0) return null;
  if (value < range.min || value > range.max) {
    return range.zero
      ? `${key} must be 0 or ${String(range.min)} to ${String(range.max)} seconds`
      : `${key} must be ${String(range.min)} to ${String(range.max)} seconds`;
  }
  return null;
}

// --- Commands ---

export interface DataPlanCommand {
  action: 'SetVariables' | 'ChangeConfiguration';
  payload: Record<string, unknown>;
}

export interface BuildDataPlanCommandsOptions {
  /** Adds the heartbeat interval (a live change; the boot reply carries it at boot). */
  includeHeartbeat: boolean;
  /** `charging` sends only the readings while charging (a charging kind change). */
  scope?: 'all' | 'charging';
}

function setVariable(component: string, variable: string, value: string): DataPlanCommand {
  return {
    action: 'SetVariables',
    payload: {
      setVariableData: [
        { component: { name: component }, variable: { name: variable }, attributeValue: value },
      ],
    },
  };
}

function changeConfiguration(key: string, value: string): DataPlanCommand {
  return { action: 'ChangeConfiguration', payload: { key, value } };
}

/**
 * The commands that put a station on its plan's values: one SetVariables per
 * variable (2.0.1 and 2.1) or one ChangeConfiguration per key (1.6). The
 * charging values come from the station's charging kind. An idle interval of
 * 0 is sent (no idle readings, OCPP 2.x AlignedDataCtrlr.Interval and 1.6
 * ClockAlignedDataInterval); the idle measurands go only with an interval
 * above 0. A 2.x list holds only the measurands of the station's protocol; a
 * list that becomes empty is not sent, since an empty value clears it.
 */
export function buildDataPlanCommands(
  protocol: string | null | undefined,
  values: DataPlanValues,
  kind: ChargingKind,
  options: BuildDataPlanCommandsOptions,
): DataPlanCommand[] {
  const charging = values[kind];
  const chargingOnly = options.scope === 'charging';
  const commands: DataPlanCommand[] = [];

  if (isOcpp2x(protocol)) {
    const list = (csv: string): string => measurandsForProtocol(csv, protocol);
    if (options.includeHeartbeat && !chargingOnly) {
      commands.push(
        setVariable('OCPPCommCtrlr', 'HeartbeatInterval', String(values.heartbeatInterval)),
      );
    }
    if (charging.meterValueInterval > 0) {
      commands.push(
        setVariable('SampledDataCtrlr', 'TxUpdatedInterval', String(charging.meterValueInterval)),
      );
    }
    const sampled = list(charging.sampledMeasurands);
    if (sampled !== '') {
      commands.push(setVariable('SampledDataCtrlr', 'TxUpdatedMeasurands', sampled));
    }
    if (chargingOnly) return commands;
    const ended = list(values.txEndedMeasurands);
    if (ended !== '') commands.push(setVariable('SampledDataCtrlr', 'TxEndedMeasurands', ended));
    if (values.clockAlignedInterval >= 0) {
      commands.push(
        setVariable('AlignedDataCtrlr', 'Interval', String(values.clockAlignedInterval)),
      );
    }
    const aligned = list(values.alignedMeasurands);
    if (values.clockAlignedInterval > 0 && aligned !== '') {
      commands.push(setVariable('AlignedDataCtrlr', 'Measurands', aligned));
    }
    return commands;
  }

  if (protocol === 'ocpp1.6') {
    // Only 1.6 measurands: one unknown value makes the station refuse the key.
    const list = (csv: string): string => measurandsForProtocol(csv, protocol);
    if (options.includeHeartbeat && !chargingOnly) {
      commands.push(changeConfiguration('HeartbeatInterval', String(values.heartbeatInterval)));
    }
    if (charging.meterValueInterval > 0) {
      commands.push(
        changeConfiguration('MeterValueSampleInterval', String(charging.meterValueInterval)),
      );
    }
    const sampled = list(charging.sampledMeasurands);
    if (sampled !== '') commands.push(changeConfiguration('MeterValuesSampledData', sampled));
    if (chargingOnly) return commands;
    const ended = list(values.txEndedMeasurands);
    if (ended !== '') commands.push(changeConfiguration('StopTxnSampledData', ended));
    if (values.clockAlignedInterval >= 0) {
      commands.push(
        changeConfiguration('ClockAlignedDataInterval', String(values.clockAlignedInterval)),
      );
    }
    const aligned = list(values.alignedMeasurands);
    if (values.clockAlignedInterval > 0 && aligned !== '') {
      commands.push(changeConfiguration('MeterValuesAlignedData', aligned));
    }
  }
  return commands;
}

// --- Boot-owned settings ---

/**
 * The station settings the boot push owns, per OCPP version. A configuration
 * template never sets them (400 DATA_PLAN_SETTING_IN_TEMPLATE) and the drift
 * check leaves them out. A test checks the list against buildDataPlanCommands.
 */
export const BOOT_OWNED_STATION_SETTINGS = {
  '1.6': [
    'HeartbeatInterval',
    'MeterValueSampleInterval',
    'MeterValuesSampledData',
    'ClockAlignedDataInterval',
    'MeterValuesAlignedData',
    'StopTxnSampledData',
  ],
  '2.x': [
    { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' },
    { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval' },
    { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' },
    { component: 'SampledDataCtrlr', variable: 'TxEndedMeasurands' },
    { component: 'AlignedDataCtrlr', variable: 'Interval' },
    { component: 'AlignedDataCtrlr', variable: 'Measurands' },
  ],
} as const;

const BOOT_OWNED_16: ReadonlySet<string> = new Set(BOOT_OWNED_STATION_SETTINGS['1.6']);
const BOOT_OWNED_2X: ReadonlySet<string> = new Set(
  BOOT_OWNED_STATION_SETTINGS['2.x'].map((e) => `${e.component}.${e.variable}`),
);

/**
 * Whether a template or station configuration variable is owned by the boot
 * push. `ocppVersion` is a template version ('1.6', '2.1', '2.0.1') or an OCPP
 * protocol ('ocpp1.6', ...). Names are compared trimmed; a 1.6 key has no
 * component (one given is ignored).
 */
export function isBootOwnedStationSetting(
  ocppVersion: string | null | undefined,
  component: string | null | undefined,
  variable: string | null | undefined,
): boolean {
  const name = (variable ?? '').trim();
  if (name === '') return false;
  if (ocppVersion === '1.6' || ocppVersion === 'ocpp1.6') return BOOT_OWNED_16.has(name);
  return BOOT_OWNED_2X.has(`${(component ?? '').trim()}.${name}`);
}
