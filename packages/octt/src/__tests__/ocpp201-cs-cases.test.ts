// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getCsRegistry, getCsTestById } from '../cs-registry.js';
import { OCPP201_CS_TEST_IDS, OCPP201_CS_TEST_NAMES } from '../ocpp201-cs-cases.js';
import { getNotApplicable } from '../pics/index.js';

const repoRoot = new URL('../../../../', import.meta.url).pathname;

/** The CS case ids a docs/octt Part 6 extract defines (`## TC_X_NN_CS: title`). */
function documentedIds(version: string): Map<string, string> | null {
  const dir = join(repoRoot, 'docs/octt', version, 'cs');
  if (!existsSync(dir)) return null;
  const ids = new Map<string, string>();
  for (const module of readdirSync(dir)) {
    for (const file of readdirSync(join(dir, module))) {
      const text = readFileSync(join(dir, module, file), 'utf8');
      for (const m of text.matchAll(/^## (TC_[A-Z]_\d+_CS): ?(.*)$/gm)) {
        ids.set(m[1] as string, (m[2] ?? '').trim());
      }
    }
  }
  return ids;
}

describe('OCPP 2.0.1 CS cases', () => {
  const registry = getCsRegistry();
  const v201 = registry.filter((t) => t.version === 'ocpp2.0.1');

  it('lists 424 distinct ids, one variant each', () => {
    expect(OCPP201_CS_TEST_IDS).toHaveLength(424);
    expect(new Set(OCPP201_CS_TEST_IDS).size).toBe(424);
    expect(v201.map((t) => t.id).sort()).toEqual([...OCPP201_CS_TEST_IDS].sort());
  });

  it('derives each variant from the 2.1 case of the same id', () => {
    for (const tc of v201) {
      const base = getCsTestById(tc.id, 'ocpp2.1');
      expect(base, tc.id).toBeDefined();
      expect(tc.execute, tc.id).toBe(base?.execute);
      expect(tc.module, tc.id).toBe(base?.module);
      expect(tc.stationConfig, tc.id).toBe(base?.stationConfig);
      expect(tc.name, tc.id).toBe(OCPP201_CS_TEST_NAMES[tc.id] ?? base?.name);
    }
  });

  it('looks cases up by id and version', () => {
    expect(getCsTestById('TC_B_01_CS', 'ocpp2.0.1')?.version).toBe('ocpp2.0.1');
    expect(getCsTestById('TC_B_01_CS', 'ocpp2.1')?.version).toBe('ocpp2.1');
    expect(getCsTestById('TC_K_57_CS', 'ocpp2.0.1')?.name).toBe(
      'Renegotiating a Charging Schedule - Initiated by EV',
    );
    // 2.1-only cases have no 2.0.1 variant.
    expect(getCsTestById('TC_Q_100_CS', 'ocpp2.0.1')).toBeUndefined();
    expect(getCsTestById('TC_Q_100_CS', 'ocpp2.1')).toBeDefined();
  });

  it('keeps one case per id and version', () => {
    const keys = registry.map((t) => `${t.version}:${t.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies the 2.1 PICS conditions of the 2.0.1 ids', () => {
    expect(getNotApplicable('TC_K_57_CS', 'ocpp2.0.1', 'cs')?.item).toBe('ISO15118Support');
    expect(getNotApplicable('TC_B_15_CS', 'ocpp2.0.1', 'cs')?.item).toBe('C-56');
    expect(getNotApplicable('TC_B_01_CS', 'ocpp2.0.1', 'cs')).toBeNull();
  });

  it('leaves out the cases 2.0.1 cannot carry, which 2.1 runs', () => {
    // QR code payment: SetDefaultTariff and NotifyWebPaymentStarted are 2.1 only.
    expect(getNotApplicable('TC_C_127_CS', 'ocpp2.0.1', 'cs')?.item).toBe('P-2.4');
    expect(getNotApplicable('TC_C_127_CS', 'ocpp2.1', 'cs')).toBeNull();
    // NotSupportedState: the simulator supports every 2.0.1 state, not Suspended (2.1).
    expect(getNotApplicable('TC_O_18_CS', 'ocpp2.0.1', 'cs')?.item).toBe(
      'UnsupportedDisplayMessageState',
    );
    expect(getNotApplicable('TC_O_18_CS', 'ocpp2.1', 'cs')).toBeNull();
  });

  // The Part 6 extracts are private (docs/), so the check runs where they exist.
  const doc201 = documentedIds('2.0.1');
  it.skipIf(doc201 == null)('matches the OCPP 2.0.1 Edition 4 Part 6 case list and titles', () => {
    const ids = doc201 as Map<string, string>;
    expect([...ids.keys()].sort()).toEqual([...OCPP201_CS_TEST_IDS].sort());
    for (const [id, title] of Object.entries(OCPP201_CS_TEST_NAMES)) {
      expect(ids.get(id), id).toBe(title);
    }
  });
});
