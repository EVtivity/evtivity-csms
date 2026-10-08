// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));

function chainResolving(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

describe('parseFleetCreditReservationCents', () => {
  it('accepts whole cents from 1 to the maximum', async () => {
    const { parseFleetCreditReservationCents } = await import('../lib/fleet-credit-settings.js');
    expect(parseFleetCreditReservationCents(1)).toBe(1);
    expect(parseFleetCreditReservationCents(5000)).toBe(5000);
    expect(parseFleetCreditReservationCents(100_000_000)).toBe(100_000_000);
  });

  it('refuses 0, negative, fractional, too high and non-number values', async () => {
    const { parseFleetCreditReservationCents } = await import('../lib/fleet-credit-settings.js');
    expect(parseFleetCreditReservationCents(0)).toBeNull();
    expect(parseFleetCreditReservationCents(-5)).toBeNull();
    expect(parseFleetCreditReservationCents(12.5)).toBeNull();
    expect(parseFleetCreditReservationCents(100_000_001)).toBeNull();
    expect(parseFleetCreditReservationCents('5000')).toBeNull();
    expect(parseFleetCreditReservationCents(null)).toBeNull();
  });
});

describe('getFleetCreditReservationCents', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the stored slice and caches it for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 7500 }]));
    const { getFleetCreditReservationCents } = await import('../lib/fleet-credit-settings.js');
    await expect(getFleetCreditReservationCents()).resolves.toBe(7500);
    await getFleetCreditReservationCents();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns the default when the key is missing or invalid, and rereads after a clear', async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    const { getFleetCreditReservationCents, clearFleetCreditSettingsCache } =
      await import('../lib/fleet-credit-settings.js');
    await expect(getFleetCreditReservationCents()).resolves.toBe(5000);

    clearFleetCreditSettingsCache();
    mockSelect.mockReturnValue(chainResolving([{ value: 0 }]));
    await expect(getFleetCreditReservationCents()).resolves.toBe(5000);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('keeps the last value on a read error', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 2500 }]));
    const { getFleetCreditReservationCents, clearFleetCreditSettingsCache } =
      await import('../lib/fleet-credit-settings.js');
    await getFleetCreditReservationCents();
    clearFleetCreditSettingsCache();
    mockSelect.mockReturnValue(chainResolving(new Error('db down')));
    await expect(getFleetCreditReservationCents()).resolves.toBe(5000);
  });
});
