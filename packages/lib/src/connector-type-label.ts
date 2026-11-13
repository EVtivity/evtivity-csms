// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The name drivers and operators see for a connector type (owner decision
// 2026-11-13). Display only: stored values, the API, OCPP messages and filter
// values keep the station's spelling. Covers the CSMS spellings
// (`CONNECTOR_TYPES`) and every OCPP 2.1 ConnectorEnumType value (OCPP 2.1
// Part 2, appendix ConnectorEnumType). The standard names are the same in
// every language; "Other" and "Pantograph" are words, so each app passes them
// translated.

/** The translated words the label uses. */
export interface ConnectorTypeWords {
  other: string;
  pantograph: string;
}

/** A standard name, or a word the app translates. */
export type ConnectorTypeLabelEntry = string | { word: keyof ConnectorTypeWords };

const OTHER: ConnectorTypeLabelEntry = { word: 'other' };
const PANTOGRAPH: ConnectorTypeLabelEntry = { word: 'pantograph' };

/** Labels by the type compared lowercase with everything but letters and digits removed. */
export const CONNECTOR_TYPE_LABELS: Readonly<Record<string, ConnectorTypeLabelEntry>> = {
  // IEC 62196-2 Type 1, a.k.a. SAE J1772 (cType1, sType1).
  type1: 'J1772',
  ctype1: 'J1772',
  stype1: 'J1772',
  j1772: 'J1772',
  // IEC 62196-2 Type 2 (cType2, sType2).
  type2: 'Type 2',
  ctype2: 'Type 2',
  stype2: 'Type 2',
  // IEC 62196-2 Type 3 socket (sType3).
  stype3: 'Type 3',
  ccs1: 'CCS1',
  cccs1: 'CCS1',
  combo1: 'CCS1',
  ccs2: 'CCS2',
  cccs2: 'CCS2',
  combo2: 'CCS2',
  // JARI G105, a.k.a. CHAdeMO (cG105).
  chademo: 'CHAdeMO',
  cg105: 'CHAdeMO',
  // ChaoJi, a.k.a. CHAdeMO 3.0, and Ultra-ChaoJi.
  cchaoji: 'ChaoJi',
  cultrachaoji: 'Ultra-ChaoJi',
  // SAE J3400 (cNACS) and the built-in adapters.
  nacs: 'NACS',
  cnacs: 'NACS',
  j3400: 'NACS',
  cnacsccs1: 'NACS-CCS1',
  cccs1nacs: 'CCS1-NACS',
  tesla: 'Tesla',
  ctesla: 'Tesla',
  mcs: 'MCS',
  cmcs: 'MCS',
  gbt: 'GB/T',
  cgbtdc: 'GB/T',
  cleccs: 'LECCS',
  // IEC 60309 sockets, BS 1361, CEE 7/7.
  s3091p16a: 'IEC 60309 1P 16A',
  s3091p32a: 'IEC 60309 1P 32A',
  s3093p16a: 'IEC 60309 3P 16A',
  s3093p32a: 'IEC 60309 3P 32A',
  sbs1361: 'BS 1361',
  scee77: 'CEE 7/7',
  // OppCharge (pantograph down) and Pan (pantograph up).
  oppcharge: PANTOGRAPH,
  pan: PANTOGRAPH,
  pantograph: PANTOGRAPH,
  // Types the spec names only generically.
  winductive: OTHER,
  wresonant: OTHER,
  bbatteryslot: OTHER,
  other1phmax16a: OTHER,
  other1phover16a: OTHER,
  other3ph: OTHER,
  undetermined: OTHER,
  unknown: OTHER,
};

/** The display name of a connector type; "Other" for none or Unknown, an unlisted value with a space before trailing digits. */
export function connectorTypeLabel(
  type: string | null | undefined,
  words: ConnectorTypeWords,
): string {
  const raw = (type ?? '').trim();
  if (raw === '') return words.other;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = Object.hasOwn(CONNECTOR_TYPE_LABELS, key) ? CONNECTOR_TYPE_LABELS[key] : undefined;
  if (label == null) return raw.replace(/^(.*?[A-Za-z])(\d+)$/, '$1 $2');
  return typeof label === 'string' ? label : words[label.word];
}
