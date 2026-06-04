// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { FREE_VEND_OCPP_21_VARIABLES, FREE_VEND_OCPP_16_KEYS } from '../free-vend-defaults.js';

describe('FREE_VEND_OCPP_21_VARIABLES', () => {
  it('contains exactly the two OCPP 2.1 autostart variables', () => {
    expect(FREE_VEND_OCPP_21_VARIABLES).toHaveLength(2);
  });

  it('disables authorization via AuthCtrlr.Enabled = false', () => {
    expect(FREE_VEND_OCPP_21_VARIABLES).toContainEqual({
      component: 'AuthCtrlr',
      variable: 'Enabled',
      value: 'false',
    });
  });

  it('sets the transaction start point to EVConnected', () => {
    expect(FREE_VEND_OCPP_21_VARIABLES).toContainEqual({
      component: 'TxCtrlr',
      variable: 'TxStartPoint',
      value: 'EVConnected',
    });
  });

  it('gives every entry a non-empty component, variable, and value', () => {
    for (const entry of FREE_VEND_OCPP_21_VARIABLES) {
      expect(entry.component.length).toBeGreaterThan(0);
      expect(entry.variable.length).toBeGreaterThan(0);
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('FREE_VEND_OCPP_16_KEYS', () => {
  it('contains exactly the three OCPP 1.6 best-effort keys', () => {
    expect(FREE_VEND_OCPP_16_KEYS).toHaveLength(3);
  });

  it('includes the offline-authorization keys all set to true', () => {
    const map = new Map(FREE_VEND_OCPP_16_KEYS.map((k) => [k.key, k.value]));
    expect(map.get('AllowOfflineTxForUnknownId')).toBe('true');
    expect(map.get('LocalPreAuthorize')).toBe('true');
    expect(map.get('LocalAuthorizeOffline')).toBe('true');
  });

  it('has unique keys and non-empty values', () => {
    const keys = FREE_VEND_OCPP_16_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of FREE_VEND_OCPP_16_KEYS) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});
