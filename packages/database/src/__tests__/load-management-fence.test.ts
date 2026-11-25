// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  currentLoadManagementFence,
  loadManagementFenceHolds,
  runWithLoadManagementFence,
  takeLoadManagementFence,
} from '../lib/load-management-fence.js';

function sqlReturning(rows: unknown[]): postgres.Sql & { calls: () => number } {
  const fn = vi.fn(() => Promise.resolve(rows));
  const sql = fn as unknown as postgres.Sql & { calls: () => number };
  sql.calls = () => fn.mock.calls.length;
  return sql;
}

describe('load management fence', () => {
  it('returns the raised fence, or null for a site without load management', async () => {
    expect(await takeLoadManagementFence(sqlReturning([{ fence: '4' }]), 'sit_a')).toBe(4);
    expect(await takeLoadManagementFence(sqlReturning([]), 'sit_a')).toBeNull();
  });

  it('holds outside a fenced cycle without reading the database', async () => {
    const sql = sqlReturning([{ fence: 9 }]);
    expect(await loadManagementFenceHolds(sql, 'sit_a')).toBe(true);
    expect(sql.calls()).toBe(0);
  });

  it('is scoped to its own site', async () => {
    await runWithLoadManagementFence({ siteId: 'sit_a', fence: 2 }, async () => {
      expect(currentLoadManagementFence('sit_a')?.fence).toBe(2);
      expect(currentLoadManagementFence('sit_b')).toBeUndefined();
      await Promise.resolve();
    });
    expect(currentLoadManagementFence('sit_a')).toBeUndefined();
  });

  it('holds while the stored fence is its own and the lease is live', async () => {
    const live = new AbortController();
    await runWithLoadManagementFence(
      { siteId: 'sit_a', fence: 3, signal: live.signal },
      async () => {
        expect(await loadManagementFenceHolds(sqlReturning([{ fence: '3' }]), 'sit_a')).toBe(true);
        expect(await loadManagementFenceHolds(sqlReturning([{ fence: '4' }]), 'sit_a')).toBe(false);
        live.abort();
        expect(await loadManagementFenceHolds(sqlReturning([{ fence: '3' }]), 'sit_a')).toBe(false);
      },
    );
  });
});
