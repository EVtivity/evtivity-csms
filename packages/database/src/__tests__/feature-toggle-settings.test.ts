// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('../config.js', () => ({ db: { select: h.select } }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ col, value }),
}));

function settingRows(rows: unknown[]): void {
  h.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

// Under load (a full run) the first import of the module graph can outlast
// the 5 s test timeout. Load it once here with a longer hook timeout; each
// test still imports a fresh copy after vi.resetModules, from the warm cache.
beforeAll(async () => {
  await import('../lib/support-setting.js');
  await import('../lib/fleet-setting.js');
  await import('../lib/guest-setting.js');
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  h.select.mockReset();
});

describe('feature toggle readers', () => {
  it('isSupportEnabled caches until clearSupportCache', async () => {
    const mod = await import('../lib/support-setting.js');
    settingRows([{ value: true }]);
    expect(await mod.isSupportEnabled()).toBe(true);
    settingRows([{ value: false }]);
    expect(await mod.isSupportEnabled()).toBe(true);
    mod.clearSupportCache();
    expect(await mod.isSupportEnabled()).toBe(false);
  });

  it('isFleetEnabled caches until clearFleetCache', async () => {
    const mod = await import('../lib/fleet-setting.js');
    settingRows([{ value: false }]);
    expect(await mod.isFleetEnabled()).toBe(false);
    settingRows([]);
    expect(await mod.isFleetEnabled()).toBe(false);
    mod.clearFleetCache();
    expect(await mod.isFleetEnabled()).toBe(true);
  });

  it('isGuestChargingEnabled caches until clearGuestChargingCache', async () => {
    const mod = await import('../lib/guest-setting.js');
    settingRows([{ value: false }]);
    expect(await mod.isGuestChargingEnabled()).toBe(false);
    settingRows([{ value: true }]);
    expect(await mod.isGuestChargingEnabled()).toBe(false);
    mod.clearGuestChargingCache();
    expect(await mod.isGuestChargingEnabled()).toBe(true);
  });
});
