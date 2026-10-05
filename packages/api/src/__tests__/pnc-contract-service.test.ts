// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {},
  drivers: {},
  driverTokens: {},
  pncContracts: {},
  settings: {},
}));
vi.mock('../services/token.service.js', () => ({}));

import { generateEmaid, normalizePcid } from '../services/pnc-contract.service.js';
import { isServerManagedSetting } from '../lib/settings-crypto.js';

describe('generateEmaid', () => {
  it('builds country, provider, ID type C and an 8 character instance', () => {
    const emaids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const emaid = generateEmaid('US', 'EVT');
      expect(emaid).toMatch(/^USEVTC[0-9A-Z]{8}$/);
      emaids.add(emaid);
    }
    expect(emaids.size).toBeGreaterThan(45);
  });
});

describe('normalizePcid', () => {
  it('keeps letters and digits in upper case', () => {
    expect(normalizePcid('wmi-v 0001.x')).toBe('WMIV0001X');
    expect(normalizePcid('---')).toBe('');
  });
});

describe('isServerManagedSetting', () => {
  it('covers the local contract CA bundle only', () => {
    expect(isServerManagedSetting('pnc.local.caEnc')).toBe(true);
    expect(isServerManagedSetting('pnc.hubject.clientSecretEnc')).toBe(false);
    expect(isServerManagedSetting('pnc.local.emaidCountry')).toBe(false);
  });
});
