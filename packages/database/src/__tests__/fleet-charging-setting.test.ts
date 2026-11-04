// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ select: vi.fn(), where: vi.fn() }));

vi.mock('../config.js', () => ({ db: { select: h.select } }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ col, value }),
}));

function settingRows(rows: unknown[]): void {
  h.where.mockImplementation(() => Promise.resolve(rows));
  h.select.mockReturnValue({ from: () => ({ where: h.where }) });
}

beforeAll(async () => {
  await import('../lib/fleet-charging-setting.js');
}, 30_000);

beforeEach(() => {
  vi.resetModules();
  h.select.mockReset();
  h.where.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isFleetChargingEnabled', () => {
  it('is off when the row is missing', async () => {
    const mod = await import('../lib/fleet-charging-setting.js');
    settingRows([]);
    expect(await mod.isFleetChargingEnabled()).toBe(false);
  });

  it('is on only for a true row', async () => {
    const mod = await import('../lib/fleet-charging-setting.js');
    settingRows([{ value: true }]);
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    mod.clearFleetChargingSettingCache();
    settingRows([{ value: 'true' }]);
    expect(await mod.isFleetChargingEnabled()).toBe(false);
  });

  it('reads the database once within 60 seconds, and again after the cache is cleared or expires', async () => {
    vi.useFakeTimers();
    const mod = await import('../lib/fleet-charging-setting.js');
    settingRows([{ value: true }]);
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    settingRows([{ value: false }]);
    vi.advanceTimersByTime(59_000);
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(await mod.isFleetChargingEnabled()).toBe(false);
    expect(h.select).toHaveBeenCalledTimes(2);

    settingRows([{ value: true }]);
    mod.clearFleetChargingSettingCache();
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(3);
  });

  it('answers false when the read fails, also after an earlier true', async () => {
    vi.useFakeTimers();
    const mod = await import('../lib/fleet-charging-setting.js');
    settingRows([{ value: true }]);
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    vi.advanceTimersByTime(61_000);
    h.where.mockImplementation(() => Promise.reject(new Error('connection lost')));
    expect(await mod.isFleetChargingEnabled()).toBe(false);
  });

  it('keeps a failed read as off for 5 seconds, then reads again', async () => {
    vi.useFakeTimers();
    const mod = await import('../lib/fleet-charging-setting.js');
    h.select.mockReturnValue({ from: () => ({ where: h.where }) });
    h.where.mockImplementation(() => Promise.reject(new Error('connection lost')));
    expect(await mod.isFleetChargingEnabled()).toBe(false);
    settingRows([{ value: true }]);
    vi.advanceTimersByTime(4_000);
    expect(await mod.isFleetChargingEnabled()).toBe(false);
    expect(h.select).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(await mod.isFleetChargingEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(2);
  });
});
