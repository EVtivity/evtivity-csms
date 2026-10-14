// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  FREE_VEND_OCPP_21_VARIABLES,
  FREE_VEND_OCPP_16_KEYS,
  FREE_VEND_RESTORE_OCPP_16_DEFAULTS,
  FREE_VEND_RESTORE_TX_START_POINT,
  freeVendRestoreKeys16,
  freeVendRestoreVariables21,
} from '../free-vend-defaults.js';

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

describe('free vend restore values', () => {
  it('turns 2.1 authorization back on and keeps the start point the stations reported', () => {
    expect(freeVendRestoreVariables21('Authorized,EVConnected')).toEqual([
      { component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
      { component: 'TxCtrlr', variable: 'TxStartPoint', value: 'Authorized,EVConnected' },
    ]);
  });

  it('uses PowerPathClosed when no start point was reported or it was the free vend one', () => {
    for (const reported of [null, undefined, '', 'EVConnected']) {
      expect(freeVendRestoreVariables21(reported)).toContainEqual({
        component: 'TxCtrlr',
        variable: 'TxStartPoint',
        value: FREE_VEND_RESTORE_TX_START_POINT,
      });
    }
  });

  it('always refuses unknown 1.6 ids offline and keeps reported local settings', () => {
    const keys = freeVendRestoreKeys16({
      LocalPreAuthorize: 'TRUE',
      LocalAuthorizeOffline: 'false',
    });
    expect(keys).toEqual([
      {
        component: 'AllowOfflineTxForUnknownId',
        variable: 'AllowOfflineTxForUnknownId',
        value: 'false',
      },
      { component: 'LocalPreAuthorize', variable: 'LocalPreAuthorize', value: 'true' },
      { component: 'LocalAuthorizeOffline', variable: 'LocalAuthorizeOffline', value: 'false' },
    ]);
  });

  it('falls back to the documented 1.6 defaults for missing or invalid values', () => {
    const map = new Map(
      freeVendRestoreKeys16({ LocalPreAuthorize: 'maybe' }).map((k) => [k.variable, k.value]),
    );
    expect(map.get('LocalPreAuthorize')).toBe(FREE_VEND_RESTORE_OCPP_16_DEFAULTS.LocalPreAuthorize);
    expect(map.get('LocalAuthorizeOffline')).toBe(
      FREE_VEND_RESTORE_OCPP_16_DEFAULTS.LocalAuthorizeOffline,
    );
  });
});
