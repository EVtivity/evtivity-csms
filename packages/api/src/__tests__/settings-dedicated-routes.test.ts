// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Security case 267: a setting with a dedicated route (its own permission,
// proof and range checks) is never read or written through the generic
// /v1/settings routes, or the dedicated route's guards are bypassed.

import { describe, expect, it } from 'vitest';
import { PAYMENT_TERMINAL_SETTING_KEY_LIST, SIM_SETTING_KEY_LIST } from '@evtivity/lib';
import { isDedicatedRouteSetting } from '../routes/settings.js';

/** Every key prefix that has a dedicated route, with that route. */
const DEDICATED_PREFIXES: Readonly<Record<string, string>> = {
  'sso.': '/v1/sso/settings',
  'security.': '/v1/security/*',
  'sim.': '/v1/settings/sim-providers',
  'paymentTerminals.': '/v1/settings/payment-terminals',
};

describe('dedicated-route settings', () => {
  it('refuses every key of every prefix that has its own route, secrets included', () => {
    const keys = [
      ...PAYMENT_TERMINAL_SETTING_KEY_LIST,
      ...SIM_SETTING_KEY_LIST,
      'sso.certEnc',
      'security.recaptcha.secretKeyEnc',
    ];
    for (const key of keys) {
      const prefix = Object.keys(DEDICATED_PREFIXES).find((p) => key.startsWith(p));
      expect(prefix, key).toBeDefined();
      expect(isDedicatedRouteSetting(key), key).toBe(true);
    }
  });

  it('refuses every payment terminal account key, an unknown one included', () => {
    for (const key of PAYMENT_TERMINAL_SETTING_KEY_LIST) {
      expect(isDedicatedRouteSetting(key)).toBe(true);
    }
    expect(isDedicatedRouteSetting('paymentTerminals.idtech.baseUrl')).toBe(true);
    expect(PAYMENT_TERMINAL_SETTING_KEY_LIST.filter((k) => k.endsWith('Enc'))).toHaveLength(3);
  });

  it('keeps general settings on the generic routes', () => {
    expect(isDedicatedRouteSetting('company.name')).toBe(false);
    expect(isDedicatedRouteSetting('payments.provider')).toBe(false);
  });
});
