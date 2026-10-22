// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@evtivity/lib';

const mockWhere = vi.fn();
vi.mock('../config.js', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockWhere })) })) },
}));

import {
  clearSimSettingsCache,
  getSimGeneralSettings,
  getSimProviderSettings,
  parseSimSettings,
} from '../lib/sim-settings.js';

const KEY = 'a'.repeat(64);

beforeEach(() => {
  clearSimSettingsCache();
  mockWhere.mockReset();
});

describe('parseSimSettings', () => {
  it('decrypts the API key, trims the organization id and fills the defaults', () => {
    const settings = parseSimSettings(
      [
        { key: 'sim.hologram.enabled', value: true },
        { key: 'sim.hologram.orgId', value: ' 1234 ' },
        { key: 'sim.hologram.apiKeyEnc', value: encryptString(' secret-key ', KEY) },
      ],
      KEY,
    );
    expect(settings.hologram).toEqual({ enabled: true, apiKey: 'secret-key', orgId: '1234' });
    expect(settings.retentionDays).toBe(90);
    expect(settings.fetchDays).toBe(7);
    expect(settings.stationSignalEnabled).toBe(false);
  });

  it('reads an organization id the jsonb reader returned as a number', () => {
    const settings = parseSimSettings([{ key: 'sim.hologram.orgId', value: 1000001 }], KEY);
    expect(settings.hologram.orgId).toBe('1000001');
  });

  it('leaves Hologram off and without a key for empty or broken values', () => {
    expect(parseSimSettings([], KEY).hologram).toEqual({ enabled: false, apiKey: '', orgId: '' });
    const broken = parseSimSettings(
      [
        { key: 'sim.hologram.enabled', value: 'true' },
        { key: 'sim.hologram.apiKeyEnc', value: 'not-ciphertext' },
      ],
      KEY,
    );
    expect(broken.hologram).toEqual({ enabled: false, apiKey: '', orgId: '' });
  });
});

describe('getSimProviderSettings', () => {
  it('reads once a minute and again after the cache is cleared', async () => {
    mockWhere.mockResolvedValue([{ key: 'sim.hologram.enabled', value: true }]);
    expect((await getSimProviderSettings(KEY)).hologram.enabled).toBe(true);
    mockWhere.mockResolvedValue([]);
    expect((await getSimProviderSettings(KEY)).hologram.enabled).toBe(true);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    clearSimSettingsCache();
    expect((await getSimProviderSettings(KEY)).hologram.enabled).toBe(false);
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it('answers the defaults when the first read fails', async () => {
    mockWhere.mockRejectedValue(new Error('database down'));
    const settings = await getSimProviderSettings(KEY);
    expect(settings.hologram.enabled).toBe(false);
    expect(settings.stationSignalEnabled).toBe(false);
  });
});

describe('getSimGeneralSettings', () => {
  it('reads the signal settings without decrypting, once a minute and again after a clear', async () => {
    mockWhere.mockResolvedValue([
      { key: 'sim.stationSignal.enabled', value: true },
      { key: 'sim.signal.alertBelowDbm', value: -100 },
      { key: 'sim.hologram.apiKeyEnc', value: 'not-ciphertext' },
    ]);
    const first = await getSimGeneralSettings();
    expect(first.stationSignalEnabled).toBe(true);
    expect(first.signalAlertBelowDbm).toBe(-100);
    expect(first).not.toHaveProperty('hologram');
    mockWhere.mockResolvedValue([]);
    expect((await getSimGeneralSettings()).stationSignalEnabled).toBe(true);
    clearSimSettingsCache();
    expect((await getSimGeneralSettings()).stationSignalEnabled).toBe(false);
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it('answers the defaults when the first read fails', async () => {
    mockWhere.mockRejectedValue(new Error('database down'));
    const settings = await getSimGeneralSettings();
    expect(settings.stationSignalEnabled).toBe(false);
    expect(settings.signalAlertBelowDbm).toBeNull();
  });
});
