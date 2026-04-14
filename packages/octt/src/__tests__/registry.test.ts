// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getRegistry, getTestById } from '../registry.js';

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
      expect(['ocpp1.6', 'ocpp2.1']).toContain(tc.version);
      expect(['csms', 'cs']).toContain(tc.sut);
      expect(typeof tc.execute).toBe('function');
    }
  });

  it('has no duplicate IDs', () => {
    const tests = getRegistry();
    const ids = tests.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds test by ID', () => {
    const tc = getTestById('TC_B_01_CSMS');
    expect(tc).toBeDefined();
    expect(tc!.module).toBe('B-provisioning');
  });

  it('returns undefined for unknown ID', () => {
    expect(getTestById('NONEXISTENT')).toBeUndefined();
  });

  it('includes both v2.1 and v1.6 tests', () => {
    const tests = getRegistry();
    const v21 = tests.filter((t) => t.version === 'ocpp2.1');
    const v16 = tests.filter((t) => t.version === 'ocpp1.6');
    expect(v21.length).toBeGreaterThan(0);
    expect(v16.length).toBeGreaterThan(0);
  });
});
