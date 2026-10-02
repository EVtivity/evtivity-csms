// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Pics, PicsItem, PicsPrerequisite } from './types.js';

/**
 * PICS of the EVtivity charging station simulator (CSS) for OCPP 2.1.
 *
 * Item ids are the OCPP 2.1 Part 5 (Certification Profiles) ids: profile
 * names, optional features (Table 2, e.g. `C-13`), and hardware features
 * (Table 4, e.g. `HFS-13`). Test conditions come from the Part 5 test case
 * list (chapter 4) and, where Part 5 has no feature id, from the test case
 * prerequisite in Part 6. Only items that decide whether a CS test case
 * applies are listed. Every unsupported item says why.
 */
const items: Record<string, PicsItem> = {
  // Certification profiles (Part 5 Table 1)
  ISO15118Support: {
    id: 'ISO15118Support',
    description:
      'Certification profile ISO 15118 support: ISO 15118-2/-20 certificate management, EIM/PnC authorization, HLC smart charging',
    supported: false,
    reason:
      'No ISO 15118 stack: the simulator has no EV-EVSE high-level communication, EV emulator, or V2G charging station certificate',
  },
  BidirectionalPowerTransfer: {
    id: 'BidirectionalPowerTransfer',
    description: 'Certification profile Bidirectional Power Transfer (V2X, V2XChargingCtrlr)',
    supported: false,
    reason:
      'No V2X: the simulator models unidirectional charging only and has no ISO 15118-20 or CHAdeMO V2X loop',
  },
  DERControl: {
    id: 'DERControl',
    description: 'Certification profile DER control (DCDERCtrlr / ACDERCtrlr)',
    supported: false,
    reason: 'No DER control: the simulator has no inverter model or DER control types',
  },

  // Optional features for charging stations (Part 5 Table 2)
  'C-09.2': {
    id: 'C-09.2',
    description: 'Start transaction options - Authorized (TxStartPoint contains Authorized)',
    supported: false,
    reason:
      'Transactions start once the EV is connected and the driver is authorized (PowerPathClosed); the simulator has no TxCtrlr.TxStartPoint',
  },
  'C-13': {
    id: 'C-13',
    description: 'Support for Reset per EVSE (AllowReset)',
    supported: true,
  },
  'C-42': {
    id: 'C-42',
    description: 'Signed Metervalues (SampledDataSignReadings, AlignedDataSignReadings)',
    supported: true,
  },
  'C-51': {
    id: 'C-51',
    description: 'Configurable TxStartPoint',
    supported: false,
    reason: 'The simulator has no TxCtrlr.TxStartPoint variable; its start point is fixed',
  },
  'C-43': {
    id: 'C-43',
    description: 'Install Firmware with ongoing transaction(s)',
    supported: false,
    reason:
      'The simulator downloads a firmware during a transaction but installs it only after all transactions ended (InstallScheduled)',
  },
  'C-60': {
    id: 'C-60',
    description: 'Support for cancelling ongoing firmware update (AcceptedCanceled)',
    supported: true,
  },
  'C-56': {
    id: 'C-56',
    description: 'Support for providing the SummaryInventory',
    supported: true,
  },
  'C-62': {
    id: 'C-62',
    description: 'Support for resuming transactions (ImmediateAndResume)',
    supported: true,
  },
  'DM-0': {
    id: 'DM-0',
    description: 'Support for Advanced Device Management (monitoring)',
    supported: true,
  },
  'DM-3': {
    id: 'DM-3',
    description:
      'Queue NotifyEventRequest messages for specific severities (OfflineMonitoringEventQueuingSeverity)',
    supported: true,
  },
  'P-0': {
    id: 'P-0',
    description: 'Support for Payment (default tariff, local cost calculation)',
    supported: true,
  },
  'P-1': {
    id: 'P-1',
    description: 'Support for Tariff conditions (TariffCostCtrlr.ConditionsSupported[Tariff])',
    supported: false,
    reason:
      'The simulator calculates cost from unconditional tariff prices only; SetDefaultTariff answers ConditionNotSupported',
  },
  'P-2.1': {
    id: 'P-2.1',
    description: 'Payment by prepaid card (C17, TxCtrlr.SupportedLimits contains MaxCost)',
    supported: true,
  },
  'P-2.2': {
    id: 'P-2.2',
    description: 'Integrated payment terminal (C18-C23)',
    supported: false,
    reason:
      'No payment terminal: the simulator has no PaymentCtrlr, card pre-authorization, settlement, or receipts',
  },
  'P-2.3': {
    id: 'P-2.3',
    description: 'Stand alone payment terminal (C24)',
    supported: false,
    reason: 'No stand-alone payment terminal or kiosk integration in the simulator',
  },
  'P-2.4': {
    id: 'P-2.4',
    description: 'QR code payment (C25, WebPaymentsCtrlr)',
    supported: true,
  },
  'SC-2.1': {
    id: 'SC-2.1',
    description: 'Supported charging rate unit A (SmartChargingCtrlr.RateUnit)',
    supported: true,
  },
  'SC-2.2': {
    id: 'SC-2.2',
    description: 'Supported charging rate unit W (SmartChargingCtrlr.RateUnit)',
    supported: true,
  },
  'SC-3': {
    id: 'SC-3',
    description: 'Support for limiting based on SoC (limitAtSoC)',
    supported: false,
    reason:
      'The simulated EV reports no state of charge (no ISO 15118 or CHAdeMO), so limitAtSoC cannot apply',
  },
  'SC-4': {
    id: 'SC-4',
    description: 'Support for TxDefaultProfile on EVSEID #0',
    supported: true,
  },
  'SC-5.1': {
    id: 'SC-5.1',
    description: 'Support for using local time (useLocalTime) with TimeOffset',
    supported: false,
    reason:
      'Charging schedules are evaluated in UTC only (SmartChargingCtrlr.SupportsFeature#UseLocalTime false)',
  },
  'SC-5.2': {
    id: 'SC-5.2',
    description: 'Support for using local time (useLocalTime) with TimeZone',
    supported: false,
    reason:
      'Charging schedules are evaluated in UTC only (SmartChargingCtrlr.SupportsFeature#UseLocalTime false)',
  },
  'SC-6': {
    id: 'SC-6',
    description: 'Support for using priority charging (PriorityCharging, K21/K22)',
    supported: false,
    reason: 'No PriorityCharging profile purpose or local priority request in the simulator',
  },
  'SC-7': {
    id: 'SC-7',
    description: 'Support for using randomized delays (randomizedDelay)',
    supported: false,
    reason:
      'No randomized start delay in the simulator (SmartChargingCtrlr.SupportsFeature#RandomizedDelay false)',
  },
  'SC-8': {
    id: 'SC-8',
    description: 'Support for dynamic charging profiles (K28/K29)',
    supported: false,
    reason:
      'Dynamic charging profiles (PullDynamicScheduleUpdate, UpdateDynamicSchedule) are not implemented',
  },

  'SC-9.1': {
    id: 'SC-9.1',
    description: 'Support for operationMode Idle with EvseSleep',
    supported: false,
    reason:
      'No EVSE sleep mode in the simulator (SmartChargingCtrlr.SupportsFeature#EvseSleep false)',
  },
  'SC-10': {
    id: 'SC-10',
    description: 'Support for EMS Control (SmartChargingCtrlr.MaxExternalConstraintsId)',
    supported: false,
    reason:
      'No local EMS interface and no MaxExternalConstraintsId; external limits only arrive from the CSMS',
  },
  // Additional PICS questions (Part 5 chapter 6)
  'AQ-7': {
    id: 'AQ-7',
    description:
      'The Charging Station is able to download firmware while there is an ongoing transaction',
    supported: true,
  },

  'AQ-10': {
    id: 'AQ-10',
    description:
      'The Charging Station supports a Delta monitor on the WriteOnly SecurityCtrlr.BasicAuthPassword',
    supported: true,
  },

  'UI-2.2': {
    id: 'UI-2.2',
    description: 'Supported message format HTML (DisplayMessageCtrlr.SupportedFormats)',
    supported: false,
    reason: 'The simulator display shows ASCII and UTF8 text only',
  },
  'UI-3': {
    id: 'UI-3',
    description: 'Multi-language support (DisplayMessageCtrlr.Language valuesList)',
    supported: true,
  },
  'AQ-19': {
    id: 'AQ-19',
    description: 'The Charging Station has at least 1 unsupported language code',
    supported: true,
  },

  // Hardware features (Part 5 Table 4)
  'HFS-13': {
    id: 'HFS-13',
    description: 'Charging Station has Battery Swapping support (BatterySwapCtrlr.Available)',
    supported: false,
    reason: 'No battery swap station model: the simulator has no battery inventory or swap bays',
  },

  // Part 6 test case prerequisites without a Part 5 feature id
  LocalEmsConnection: {
    id: 'LocalEmsConnection',
    description:
      'A local EMS or external system connected to the Charging Station can apply charging limit constraints (SC-10 EMS Control, TC_K_120/124/125 prerequisite)',
    supported: false,
    reason:
      'The simulator has no local EMS or external system interface; external limits only arrive from the CSMS',
  },
  NoSmartCharging: {
    id: 'NoSmartCharging',
    description: 'The Charging Station does not support smart charging (TC_K_15_CS prerequisite)',
    supported: false,
    reason:
      'The simulator supports smart charging (SmartChargingCtrlr.Enabled), so it never answers NotSupported',
  },
  SingleChargingRateUnit: {
    id: 'SingleChargingRateUnit',
    description:
      'Only one of the charging rate units A (SC-2.1) and W (SC-2.2) is supported (TC_K_12_CS and TC_K_42_CS condition)',
    supported: false,
    reason: 'The simulator supports both A and W (SmartChargingCtrlr.RateUnit A,W)',
  },
  NoLocalCostCalculation: {
    id: 'NoLocalCostCalculation',
    description:
      'The Charging Station does not support local cost calculation, or has it disabled (TC_I_103_CS prerequisite)',
    supported: false,
    reason:
      'The simulator supports local cost calculation (P-0). With TariffCostCtrlr.Enabled[Tariff] false it still accepts a default tariff, as TC_I_107_CS (Part 5, P-0) requires; Part 5 does not list TC_I_103',
  },
  NoLogInformationAvailable: {
    id: 'NoLogInformationAvailable',
    description:
      'The Charging Station can be in a state with no log information available (TC_N_34_CS prerequisite, N01.FR.05)',
    supported: false,
    reason:
      'The simulator always has diagnostics and security log information to upload, so it cannot be put in a state without log information',
  },
};

const needs = (item: string): PicsPrerequisite[] => [{ item, requires: true }];
const lacks = (item: string): PicsPrerequisite[] => [{ item, requires: false }];

function each(
  ids: string[],
  prerequisites: PicsPrerequisite[],
): Record<string, PicsPrerequisite[]> {
  return Object.fromEntries(ids.map((id) => [id, prerequisites]));
}

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_v, i) => `${prefix}_${String(from + i)}_CS`);

const testPrerequisites: Record<string, PicsPrerequisite[]> = {
  // B: Part 5 runs one side of each variant
  TC_B_15_CS: lacks('C-56'),
  TC_B_28_CS: lacks('C-13'),
  TC_B_29_CS: lacks('C-13'),
  TC_B_102_CS: needs('C-62'),
  TC_B_103_CS: needs('C-62'),

  // C: local start with a cable plugin timeout needs an Authorized or configurable TxStartPoint
  TC_C_100_CS: [{ anyOf: ['C-51', 'C-09.2'] }],
  // C: ISO 15118 contract certificates and payment
  ...each(range('TC_C', 50, 55), needs('ISO15118Support')),
  ...each(['TC_C_103_CS', 'TC_C_104_CS'], [...needs('P-0'), ...needs('P-2.1')]),
  ...each(
    [...range('TC_C', 105, 116), ...range('TC_C', 119, 122)],
    [...needs('P-0'), ...needs('P-2.2')],
  ),
  ...each(['TC_C_123_CS', 'TC_C_124_CS'], [...needs('P-0'), ...needs('P-2.3')]),
  ...each(range('TC_C', 127, 130), [...needs('P-0'), ...needs('P-2.4')]),

  // I: variants (Part 6 prerequisites)
  TC_I_103_CS: needs('NoLocalCostCalculation'),
  ...each(['TC_I_120_CS', 'TC_I_121_CS'], [...needs('P-0'), ...needs('P-1')]),

  // J: signed meter values
  ...each(['TC_J_04_CS', 'TC_J_11_CS'], needs('C-42')),

  // K: ISO 15118 HLC, priority charging, dynamic profiles, local EMS
  ...each(
    ['TC_K_53_CS', 'TC_K_54_CS', 'TC_K_56_CS', 'TC_K_57_CS', 'TC_K_58_CS'],
    needs('ISO15118Support'),
  ),
  ...each(range('TC_K', 113, 116), needs('ISO15118Support')),
  // K: variants and optional smart charging features (Part 5 SC-x)
  TC_K_10_CS: needs('SC-4'),
  ...each(['TC_K_12_CS', 'TC_K_42_CS'], needs('SingleChargingRateUnit')),
  TC_K_15_CS: needs('NoSmartCharging'),
  TC_K_101_CS: needs('BidirectionalPowerTransfer'),
  TC_K_102_CS: needs('SC-3'),
  TC_K_103_CS: needs('SC-5.1'),
  TC_K_136_CS: needs('SC-5.2'),
  ...each(['TC_K_104_CS', 'TC_K_129_CS'], needs('SC-6')),
  ...each(['TC_K_106_CS', 'TC_K_107_CS', 'TC_K_108_CS', 'TC_K_112_CS'], needs('SC-7')),
  ...each(['TC_K_109_CS', 'TC_K_110_CS'], needs('SC-10')),
  TC_K_130_CS: lacks('SC-6'),
  TC_K_131_CS: lacks('BidirectionalPowerTransfer'),
  TC_K_132_CS: [...lacks('SC-5.1'), ...lacks('SC-5.2')],
  TC_K_133_CS: lacks('SC-7'),
  TC_K_134_CS: lacks('SC-3'),
  TC_K_135_CS: lacks('SC-9.1'),
  ...each(['TC_K_118_CS', 'TC_K_119_CS'], needs('SC-6')),
  ...each(range('TC_K', 121, 123), needs('SC-8')),
  ...each(['TC_K_120_CS', 'TC_K_124_CS', 'TC_K_125_CS'], needs('LocalEmsConnection')),

  // L: firmware update variants (Part 5: L_11 NOT C-60, L_12/L_13 NOT AQ-7, L_16 C-43)
  TC_L_11_CS: lacks('C-60'),
  ...each(['TC_L_12_CS', 'TC_L_13_CS'], lacks('AQ-7')),
  TC_L_16_CS: needs('C-43'),

  // M: ISO 15118 V2G certificate status and EV certificate installation
  ...each([...range('TC_M', 24, 29), 'TC_M_100_CS'], needs('ISO15118Support')),

  // N: monitoring, offline event queuing, log retrieval without logs
  ...each(
    [
      'TC_N_20_CS',
      'TC_N_21_CS',
      'TC_N_45_CS',
      ...range('TC_N', 105, 106),
      ...range('TC_N', 108, 109),
    ],
    needs('DM-0'),
  ),
  ...each(['TC_N_22_CS', 'TC_N_23_CS'], [...needs('DM-0'), ...needs('DM-3')]),
  TC_N_34_CS: needs('NoLogInformationAvailable'),
  TC_N_48_CS: [...needs('DM-0'), ...needs('AQ-10')],

  // O: display message variants (Part 5: TC_O_19 needs a station without all formats)
  TC_O_19_CS: lacks('UI-2.2'),
  TC_O_100_CS: needs('AQ-19'),
  TC_O_101_CS: needs('UI-3'),

  // Q: bidirectional power transfer (V2X)
  ...each(
    [
      ...range('TC_Q', 100, 104),
      'TC_Q_107_CS',
      ...range('TC_Q', 109, 120),
      ...range('TC_Q', 122, 123),
      ...range('TC_Q', 125, 128),
      'TC_Q_130_CS',
    ],
    needs('BidirectionalPowerTransfer'),
  ),

  // R: DER control
  ...each([...range('TC_R', 100, 106), 'TC_R_108_CS'], needs('DERControl')),

  // S: battery swapping
  ...each(['TC_S_102_CS', 'TC_S_104_CS', 'TC_S_105_CS'], needs('HFS-13')),
};

export const PICS_V2_1: Pics = {
  sut: 'cs',
  version: 'ocpp2.1',
  items,
  testPrerequisites,
};
