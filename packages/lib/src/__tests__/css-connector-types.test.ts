// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CSS_CONNECTOR_TYPES,
  mapConnectorTypeToCss,
  mapCssToOcppConnectorType,
  randomCssConnectorType,
} from '../css-connector-types.js';

describe('mapConnectorTypeToCss', () => {
  it('maps known operator-facing types to css enum values', () => {
    expect(mapConnectorTypeToCss('Type2')).toBe('ac_type2');
    expect(mapConnectorTypeToCss('Type1')).toBe('ac_type1');
    expect(mapConnectorTypeToCss('CCS2')).toBe('dc_ccs2');
    expect(mapConnectorTypeToCss('CCS1')).toBe('dc_ccs1');
    expect(mapConnectorTypeToCss('CHAdeMO')).toBe('dc_chademo');
  });

  it('falls back to ac_type2 for unrepresentable plugs', () => {
    expect(mapConnectorTypeToCss('NACS')).toBe('ac_type2');
    expect(mapConnectorTypeToCss('Tesla')).toBe('ac_type2');
    expect(mapConnectorTypeToCss('GBT')).toBe('ac_type2');
  });

  it('falls back to ac_type2 for null/undefined/empty input', () => {
    expect(mapConnectorTypeToCss(null)).toBe('ac_type2');
    expect(mapConnectorTypeToCss(undefined)).toBe('ac_type2');
    expect(mapConnectorTypeToCss('')).toBe('ac_type2');
  });
});

describe('mapCssToOcppConnectorType', () => {
  it('maps every CSS_CONNECTOR_TYPES value to a non-empty OCPP 2.1 enum string', () => {
    for (const t of CSS_CONNECTOR_TYPES) {
      const ocpp = mapCssToOcppConnectorType(t);
      expect(ocpp).toBeTypeOf('string');
      expect(ocpp.length).toBeGreaterThan(0);
    }
  });

  it('maps each css type to the spec-defined OCPP 2.1 connector enum value', () => {
    expect(mapCssToOcppConnectorType('ac_type2')).toBe('cType2');
    expect(mapCssToOcppConnectorType('ac_type1')).toBe('cType1');
    expect(mapCssToOcppConnectorType('dc_ccs2')).toBe('cCCS2');
    expect(mapCssToOcppConnectorType('dc_ccs1')).toBe('cCCS1');
    expect(mapCssToOcppConnectorType('dc_chademo')).toBe('cChaoJi');
  });

  it('roundtrips through mapConnectorTypeToCss for the operator-facing values that match', () => {
    // Type2 -> ac_type2 -> cType2; the inverse-on-display path
    expect(mapCssToOcppConnectorType(mapConnectorTypeToCss('Type2'))).toBe('cType2');
    expect(mapCssToOcppConnectorType(mapConnectorTypeToCss('CCS2'))).toBe('cCCS2');
  });
});

describe('randomCssConnectorType', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first type when random lands at index 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(randomCssConnectorType()).toBe('ac_type2');
  });

  it('returns the last type when random lands at the final index', () => {
    // 0.999... * 5 = 4.99 -> floor 4 -> last element
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    expect(randomCssConnectorType()).toBe('dc_chademo');
  });

  it('falls back to ac_type2 when the computed index is out of bounds', () => {
    // Math.random contractually returns [0,1); mocking it to 1 forces
    // idx === length, hitting the defensive `?? ac_type2` fallback.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(randomCssConnectorType()).toBe('ac_type2');
  });

  it('always returns one of the CSS_CONNECTOR_TYPES', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(randomCssConnectorType());
    }
    for (const t of seen) {
      expect(CSS_CONNECTOR_TYPES).toContain(t);
    }
  });

  it('produces variety across many calls (not a single fixed value)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(randomCssConnectorType());
    }
    // 200 samples across a 5-value enum should hit at least 2 distinct values
    // with overwhelming probability (chance of all-one-value is 5 * (1/5)^200).
    expect(seen.size).toBeGreaterThan(1);
  });
});
