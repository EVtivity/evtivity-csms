// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ select: vi.fn(), where: vi.fn(), warn: vi.fn() }));

vi.mock('../config.js', () => ({ db: { select: h.select } }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ col, value }),
}));
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn: h.warn }) }));

function settingRows(rows: unknown[]): void {
  h.where.mockImplementation(() => Promise.resolve(rows));
  h.select.mockReturnValue({ from: () => ({ where: h.where }) });
}

function failingRead(): void {
  h.where.mockImplementation(() => Promise.reject(new Error('connection lost')));
  h.select.mockReturnValue({ from: () => ({ where: h.where }) });
}

const MODULE = '../lib/rfid-self-service-setting.js';

beforeAll(async () => {
  await import(MODULE);
}, 30_000);

beforeEach(() => {
  vi.resetModules();
  h.select.mockReset();
  h.where.mockReset();
  h.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDriverRfidSelfServiceEnabled', () => {
  it('names the setting key', async () => {
    const mod = await import(MODULE);
    expect(mod.RFID_SELF_SERVICE_SETTING_KEY).toBe('portal.rfidSelfServiceEnabled');
  });

  it('is on when the row is missing', async () => {
    const mod = await import(MODULE);
    settingRows([]);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
  });

  it('reads a stored true as on and a stored false as off', async () => {
    const mod = await import(MODULE);
    settingRows([{ value: true }]);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    mod.clearDriverRfidSelfServiceCache();
    settingRows([{ value: false }]);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(false);
  });

  it.each([['true'], ['false'], [0], [1], [null], [{}]])(
    'reads the non-boolean stored value %j as off',
    async (value) => {
      const mod = await import(MODULE);
      settingRows([{ value }]);
      expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(false);
    },
  );

  it('reads the database once within 60 seconds, and again after the cache is cleared or expires', async () => {
    vi.useFakeTimers();
    const mod = await import(MODULE);
    settingRows([{ value: true }]);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    settingRows([{ value: false }]);
    vi.advanceTimersByTime(59_000);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(false);
    expect(h.select).toHaveBeenCalledTimes(2);

    settingRows([{ value: true }]);
    mod.clearDriverRfidSelfServiceCache();
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    expect(h.select).toHaveBeenCalledTimes(3);
  });

  it('keeps the last read value when a later read fails', async () => {
    vi.useFakeTimers();
    const mod = await import(MODULE);
    settingRows([{ value: true }]);
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    vi.advanceTimersByTime(61_000);
    failingRead();
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('fails closed with no cached value and logs the key', async () => {
    const mod = await import(MODULE);
    failingRead();
    expect(await mod.isDriverRfidSelfServiceEnabled()).toBe(false);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'portal.rfidSelfServiceEnabled' }),
      expect.any(String),
    );
  });
});
