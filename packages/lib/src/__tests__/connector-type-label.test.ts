// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { connectorTypeLabel } from '../connector-type-label.js';
import { CONNECTOR_TYPES } from '../connector-power.js';

const words = { other: 'Other', pantograph: 'Pantograph' };
const label = (t: string | null | undefined): string => connectorTypeLabel(t, words);

describe('connectorTypeLabel', () => {
  it.each([
    ['Type1', 'J1772'],
    ['cType1', 'J1772'],
    ['sType1', 'J1772'],
    ['J1772', 'J1772'],
    ['TYPE1', 'J1772'],
    ['type1', 'J1772'],
    ['Type2', 'Type 2'],
    ['cType2', 'Type 2'],
    ['sType2', 'Type 2'],
    ['CCS1', 'CCS1'],
    ['cCCS1', 'CCS1'],
    ['CCS2', 'CCS2'],
    ['cCCS2', 'CCS2'],
    ['CHAdeMO', 'CHAdeMO'],
    ['cG105', 'CHAdeMO'],
    ['NACS', 'NACS'],
    ['cNACS', 'NACS'],
    ['cMCS', 'MCS'],
    ['MCS', 'MCS'],
    ['GBT', 'GB/T'],
    ['OppCharge', 'Pantograph'],
    ['Pan', 'Pantograph'],
    ['Unknown', 'Other'],
    ['Undetermined', 'Other'],
  ])('shows %s as %s', (type, expected) => {
    expect(label(type)).toBe(expected);
  });

  it('shows none or an empty value as Other', () => {
    expect(label(null)).toBe('Other');
    expect(label(undefined)).toBe('Other');
    expect(label('  ')).toBe('Other');
  });

  it('shows an unlisted value with a space before its trailing digits', () => {
    expect(label('Vendor9')).toBe('Vendor 9');
    expect(label('SomePlug')).toBe('SomePlug');
  });

  it('uses the translated words', () => {
    expect(connectorTypeLabel('Pan', { other: 'Sonstige', pantograph: 'Stromabnehmer' })).toBe(
      'Stromabnehmer',
    );
    expect(connectorTypeLabel('Unknown', { other: 'Sonstige', pantograph: 'x' })).toBe('Sonstige');
  });

  it('names every CSMS connector type', () => {
    for (const type of CONNECTOR_TYPES) {
      expect(label(type)).not.toBe('Other');
    }
  });

  // OCPP 2.1 Part 2, appendix ConnectorEnumType (the CSV of the spec, private).
  const csv = fileURLToPath(
    new URL(
      '../../../../docs/ocpp/OCPP-2.1/Appendices_CSV_v2.1/connectorenumtype.csv',
      import.meta.url,
    ),
  );
  it.runIf(existsSync(csv))('maps every OCPP 2.1 ConnectorEnumType value', () => {
    const values = readFileSync(csv, 'utf8')
      .split('\n')
      .slice(1)
      .map((l) => l.split(';')[0]?.trim() ?? '')
      .filter((v) => v !== '');
    expect(values.length).toBeGreaterThan(30);
    const generic = new Set([
      'bBatterySlot',
      'wInductive',
      'wResonant',
      'Other1PhMax16A',
      'Other1PhOver16A',
      'Other3Ph',
      'Undetermined',
      'Unknown',
    ]);
    for (const v of values) {
      const shown = label(v);
      if (generic.has(v)) expect(shown).toBe('Other');
      else expect(shown, v).not.toBe(v.replace(/^(.*?[A-Za-z])(\d+)$/, '$1 $2'));
    }
  });
});
