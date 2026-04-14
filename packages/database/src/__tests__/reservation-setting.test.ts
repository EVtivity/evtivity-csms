// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before importing the module under test
const mockSelect = vi.fn();
vi.mock('../config.js', () => ({
  db: {
    select: mockSelect,
  },
}));

// Mock drizzle-orm inArray so it does not require a real db
vi.mock('drizzle-orm', () => ({
  inArray: vi.fn((_col, _vals) => ({ type: 'inArray' })),
}));

// Mock the settings schema
vi.mock('../schema/settings.js', () => ({
  settings: { key: 'key', value: 'value' },
}));

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('getReservationSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns defaults when no rows exist', async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const { getReservationSettings } = await import('../lib/reservation-setting.js');
    const result = await getReservationSettings();
    expect(result).toEqual({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
    });
  });

  it('parses boolean true from JSONB for enabled', async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { key: 'reservation.enabled', value: true },
        { key: 'reservation.bufferMinutes', value: 10 },
        { key: 'reservation.cancellationWindowMinutes', value: 30 },
        { key: 'reservation.cancellationFeeCents', value: 500 },
      ]),
    );
    const { getReservationSettings } = await import('../lib/reservation-setting.js');
    const result = await getReservationSettings();
    expect(result).toEqual({
      enabled: true,
      bufferMinutes: 10,
      cancellationWindowMinutes: 30,
      cancellationFeeCents: 500,
    });
  });

  it('parses boolean false for enabled', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'reservation.enabled', value: false }]));
    const { getReservationSettings } = await import('../lib/reservation-setting.js');
    const result = await getReservationSettings();
    expect(result.enabled).toBe(false);
  });

  it('returns cached value on second call without hitting db', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'reservation.enabled', value: false }]));
    const { getReservationSettings } = await import('../lib/reservation-setting.js');
    await getReservationSettings();
    await getReservationSettings();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns defaults on db error with no prior cache', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('db error');
    });
    const { getReservationSettings } = await import('../lib/reservation-setting.js');
    const result = await getReservationSettings();
    expect(result).toEqual({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
    });
  });

  it('invalidateReservationSettingsCache clears the cache', async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const { getReservationSettings, invalidateReservationSettingsCache } =
      await import('../lib/reservation-setting.js');
    await getReservationSettings();
    invalidateReservationSettingsCache();
    await getReservationSettings();
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

describe('isReservationEnabled', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns true when reservation.enabled row is true', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'reservation.enabled', value: true }]));
    const { isReservationEnabled } = await import('../lib/reservation-setting.js');
    expect(await isReservationEnabled()).toBe(true);
  });

  it('returns false when reservation.enabled row is false', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'reservation.enabled', value: false }]));
    const { isReservationEnabled } = await import('../lib/reservation-setting.js');
    expect(await isReservationEnabled()).toBe(false);
  });

  it('defaults to true when no row exists', async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const { isReservationEnabled } = await import('../lib/reservation-setting.js');
    expect(await isReservationEnabled()).toBe(true);
  });

  it('returns the enabled field from the full settings object', async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { key: 'reservation.enabled', value: true },
        { key: 'reservation.bufferMinutes', value: 15 },
      ]),
    );
    const { isReservationEnabled } = await import('../lib/reservation-setting.js');
    // isReservationEnabled wraps getReservationSettings; a single db call serves both
    expect(await isReservationEnabled()).toBe(true);
    // Second call uses the cache — db should still have been called only once
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});
