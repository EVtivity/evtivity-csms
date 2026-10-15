// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cachedDashboardTotals,
  clearDashboardTotalsCache,
  DASHBOARD_TOTALS_TTL_MS,
  siteScopeKey,
} from '../lib/dashboard-totals.js';

describe('cachedDashboardTotals', () => {
  beforeEach(() => {
    clearDashboardTotalsCache();
  });

  it('loads once per minute and scope, shared by concurrent callers', async () => {
    const load = vi.fn().mockResolvedValue({ totalSessions: 5 });
    const [a, b] = await Promise.all([
      cachedDashboardTotals('stats:*', load, 1_000),
      cachedDashboardTotals('stats:*', load, 1_001),
    ]);
    expect(a).toEqual({ totalSessions: 5 });
    expect(b).toBe(a);
    await cachedDashboardTotals('stats:*', load, 1_000 + DASHBOARD_TOTALS_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);

    await cachedDashboardTotals('stats:*', load, 1_000 + DASHBOARD_TOTALS_TTL_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps each site scope apart', async () => {
    const load = vi.fn().mockResolvedValue(1);
    await cachedDashboardTotals(`stats:${siteScopeKey(['sit_b', 'sit_a'])}`, load, 0);
    await cachedDashboardTotals(`stats:${siteScopeKey(['sit_a', 'sit_b'])}`, load, 0);
    await cachedDashboardTotals(`stats:${siteScopeKey(null)}`, load, 0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('database down')).mockResolvedValueOnce(7);
    await expect(cachedDashboardTotals('k', load, 0)).rejects.toThrow('database down');
    await expect(cachedDashboardTotals('k', load, 1)).resolves.toBe(7);
  });
});
