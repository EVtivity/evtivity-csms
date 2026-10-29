// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  SIM_HOLOGRAM_ORG_ID_MAX_DIGITS,
  SIM_SETTING_KEYS,
  isHologramOrgId,
  isOneNceClientId,
  ONENCE_CLIENT_ID_MAX_LENGTH,
  isSimFetchDays,
  isSimRetentionDays,
  isSimSignalDbm,
  normalizeSimGeneralSettings,
  parseOcpp16SignalKeys,
} from '../sim-settings.js';

describe('isHologramOrgId', () => {
  it('takes 1 to 15 digits, trimmed, as Helm and CDK do', () => {
    expect(SIM_HOLOGRAM_ORG_ID_MAX_DIGITS).toBe(15);
    expect(isHologramOrgId('4')).toBe(true);
    expect(isHologramOrgId(' 42 ')).toBe(true);
    expect(isHologramOrgId('9'.repeat(15))).toBe(true);
    expect(isHologramOrgId('9'.repeat(16))).toBe(false);
    expect(isHologramOrgId('')).toBe(false);
    expect(isHologramOrgId('org-12')).toBe(false);
    expect(isHologramOrgId('-12')).toBe(false);
  });
});

describe('isOneNceClientId', () => {
  it('takes 1 to 128 printable ASCII characters without a space or colon, as Helm and CDK do', () => {
    expect(ONENCE_CLIENT_ID_MAX_LENGTH).toBe(128);
    expect(isOneNceClientId('a1b2-c3_D4.e5')).toBe(true);
    expect(isOneNceClientId(' client ')).toBe(true);
    expect(isOneNceClientId('x'.repeat(128))).toBe(true);
    expect(isOneNceClientId('x'.repeat(129))).toBe(false);
    expect(isOneNceClientId('')).toBe(false);
    expect(isOneNceClientId('user:secret')).toBe(false);
    expect(isOneNceClientId('two words')).toBe(false);
    expect(isOneNceClientId('tab\there')).toBe(false);
    expect(isOneNceClientId('caf\u00e9')).toBe(false);
  });

  it('names the 1NCE keys', () => {
    expect(SIM_SETTING_KEYS.oneNceEnabled).toBe('sim.1nce.enabled');
    expect(SIM_SETTING_KEYS.oneNceClientId).toBe('sim.1nce.clientId');
    expect(SIM_SETTING_KEYS.oneNceClientSecretEnc).toBe('sim.1nce.clientSecretEnc');
  });
});

describe('SIM setting ranges', () => {
  it('accepts the retention from 7 to 730 days, integers only', () => {
    expect(isSimRetentionDays(7)).toBe(true);
    expect(isSimRetentionDays(730)).toBe(true);
    for (const value of [6, 731, 90.5, '90', null]) expect(isSimRetentionDays(value)).toBe(false);
  });

  it('accepts the Refresh period from 1 to 31 days', () => {
    expect(isSimFetchDays(1)).toBe(true);
    expect(isSimFetchDays(31)).toBe(true);
    for (const value of [0, 32, 2.5]) expect(isSimFetchDays(value)).toBe(false);
  });

  it('accepts signal thresholds from -140 to -40 dBm', () => {
    expect(isSimSignalDbm(-140)).toBe(true);
    expect(isSimSignalDbm(-40)).toBe(true);
    for (const value of [-141, -39, -70.5]) expect(isSimSignalDbm(value)).toBe(false);
  });
});

describe('parseOcpp16SignalKeys', () => {
  it('trims, drops empty and repeated names', () => {
    expect(parseOcpp16SignalKeys([' RSSI ', 'CellID', '', 'RSSI'])).toEqual(['RSSI', 'CellID']);
  });

  it('refuses a non-list, a non-string, a long key and too many keys', () => {
    expect(parseOcpp16SignalKeys('RSSI')).toBeNull();
    expect(parseOcpp16SignalKeys(['RSSI', 1])).toBeNull();
    expect(parseOcpp16SignalKeys(['x'.repeat(51)])).toBeNull();
    expect(parseOcpp16SignalKeys(Array.from({ length: 21 }, (_, i) => `K${String(i)}`))).toBeNull();
  });
});

describe('normalizeSimGeneralSettings', () => {
  it('gives the defaults for no stored values', () => {
    expect(normalizeSimGeneralSettings({})).toEqual({
      retentionDays: 90,
      fetchDays: 7,
      stationSignalEnabled: false,
      signalAlertBelowDbm: null,
      ocpp16SignalKeys: [],
      signalGoodDbm: -65,
      signalFairDbm: -85,
    });
  });

  it('keeps valid stored values', () => {
    expect(
      normalizeSimGeneralSettings({
        [SIM_SETTING_KEYS.retentionDays]: 30,
        [SIM_SETTING_KEYS.fetchDays]: 14,
        [SIM_SETTING_KEYS.stationSignalEnabled]: true,
        [SIM_SETTING_KEYS.signalAlertBelowDbm]: -100,
        [SIM_SETTING_KEYS.ocpp16SignalKeys]: ['RSSI'],
        [SIM_SETTING_KEYS.signalGoodDbm]: -70,
        [SIM_SETTING_KEYS.signalFairDbm]: -90,
      }),
    ).toEqual({
      retentionDays: 30,
      fetchDays: 14,
      stationSignalEnabled: true,
      signalAlertBelowDbm: -100,
      ocpp16SignalKeys: ['RSSI'],
      signalGoodDbm: -70,
      signalFairDbm: -90,
    });
  });

  it('replaces out of range values, an empty alert and unordered thresholds', () => {
    const settings = normalizeSimGeneralSettings({
      [SIM_SETTING_KEYS.retentionDays]: 5,
      [SIM_SETTING_KEYS.fetchDays]: 40,
      [SIM_SETTING_KEYS.stationSignalEnabled]: 'true',
      [SIM_SETTING_KEYS.signalAlertBelowDbm]: '',
      [SIM_SETTING_KEYS.signalGoodDbm]: -90,
      [SIM_SETTING_KEYS.signalFairDbm]: -70,
    });
    expect(settings.retentionDays).toBe(90);
    expect(settings.fetchDays).toBe(7);
    expect(settings.stationSignalEnabled).toBe(false);
    expect(settings.signalAlertBelowDbm).toBeNull();
    expect(settings.signalGoodDbm).toBe(-65);
    expect(settings.signalFairDbm).toBe(-85);
  });
});
