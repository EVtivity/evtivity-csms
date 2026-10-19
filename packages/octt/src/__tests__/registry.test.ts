// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getRegistry, getTestById } from '../registry.js';
import { OCPP201_CSMS_TEST_IDS } from '../ocpp201-csms-cases.js';

describe('registry', () => {
  it('returns all registered test cases', () => {
    const tests = getRegistry();
    expect(tests.length).toBeGreaterThanOrEqual(7);
  });

  it('all tests have required fields', () => {
    const tests = getRegistry();
    for (const tc of tests) {
      expect(tc.id).toBeTruthy();
      expect(tc.name).toBeTruthy();
      expect(tc.module).toBeTruthy();
      expect(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']).toContain(tc.version);
      expect(['csms', 'cs']).toContain(tc.sut);
      expect(typeof tc.execute).toBe('function');
    }
  });

  it('has no duplicate IDs within a version', () => {
    for (const version of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const) {
      const ids = getRegistry(version).map((t) => t.id);
      expect(new Set(ids).size, version).toBe(ids.length);
    }
  });

  it('has no id shared between 1.6 and 2.x', () => {
    const ids16 = new Set(getRegistry('ocpp1.6').map((t) => t.id));
    const shared = getRegistry()
      .filter((t) => t.version !== 'ocpp1.6')
      .filter((t) => ids16.has(t.id));
    expect(shared).toEqual([]);
  });

  it('registers the 251 OCPP 2.0.1 CSMS cases of Part 6, each a variant of the 2.1 case', () => {
    expect(OCPP201_CSMS_TEST_IDS).toHaveLength(251);
    expect(new Set(OCPP201_CSMS_TEST_IDS).size).toBe(251);
    const v201 = getRegistry('ocpp2.0.1');
    expect(v201.map((t) => t.id)).toEqual([...OCPP201_CSMS_TEST_IDS]);
    for (const tc of v201) {
      const tc21 = getTestById(tc.id, 'ocpp2.1');
      expect(tc21, tc.id).toBeDefined();
      expect(tc.sut).toBe('csms');
      expect(tc.module).toBe(tc21!.module);
      expect(tc.execute).toBe(tc21!.execute);
      expect(tc.provision).toEqual(tc21!.provision);
      expect(tc.onboardingStatus).toBe(tc21!.onboardingStatus);
    }
  });

  it('gives the three renegotiation cases their 2.0.1 titles', () => {
    expect(getTestById('TC_K_57_CSMS', 'ocpp2.0.1')?.name).toBe(
      'Renegotiating a Charging Schedule - Initiated by EV',
    );
    expect(getTestById('TC_K_57_CSMS', 'ocpp2.1')?.name).toContain('ISO 15118-20');
    expect(getTestById('TC_K_58_CSMS', 'ocpp2.0.1')?.name).toBe(
      'Renegotiating a Charging Schedule - Initiated by CSMS',
    );
    expect(getTestById('TC_K_59_CSMS', 'ocpp2.0.1')?.name).toBe(
      'Renegotiating a Charging Schedule - Initiated by CSMS - Send NotifyEVChargingNeeds',
    );
  });

  it('keeps the 2.1-only cases out of 2.0.1', () => {
    expect(getTestById('TC_B_100_CSMS', 'ocpp2.1')).toBeDefined();
    expect(getTestById('TC_B_100_CSMS', 'ocpp2.0.1')).toBeUndefined();
    expect(getTestById('TC_Q_102_CSMS', 'ocpp2.0.1')).toBeUndefined();
  });

  it('finds a test by ID and version', () => {
    const tc = getTestById('TC_B_01_CSMS', 'ocpp2.1');
    expect(tc).toBeDefined();
    expect(tc!.module).toBe('B-provisioning');
    expect(getTestById('TC_B_01_CSMS', 'ocpp2.0.1')?.version).toBe('ocpp2.0.1');
    expect(getTestById('TC_001_CSMS', 'ocpp1.6')?.version).toBe('ocpp1.6');
    expect(getTestById('TC_001_CSMS', 'ocpp2.0.1')).toBeUndefined();
  });

  it('returns undefined for unknown ID', () => {
    expect(getTestById('NONEXISTENT', 'ocpp2.1')).toBeUndefined();
  });

  it('filters by version', () => {
    expect(getRegistry('ocpp2.0.1').every((t) => t.version === 'ocpp2.0.1')).toBe(true);
    expect(getRegistry('ocpp2.1').length).toBeGreaterThan(251);
    expect(getRegistry('ocpp1.6').length).toBeGreaterThan(0);
  });
});
