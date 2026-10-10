// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
vi.mock('@evtivity/database', () => ({ listPricingGroupsWithoutDefault: mockList }));

const { reportPricingGroupsWithoutDefault } = await import('../lib/pricing-default-report.js');

const sql = {} as postgres.Sql;

describe('reportPricingGroupsWithoutDefault (B2, TC-T3-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs one warning per pricing group without a default', async () => {
    mockList.mockResolvedValue([
      { id: 'pgr_1', name: 'Peak only' },
      { id: 'pgr_2', name: 'Weekend' },
    ]);
    const log = { warn: vi.fn() };
    expect(await reportPricingGroupsWithoutDefault(sql, log)).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({
      pricingGroupId: 'pgr_1',
      pricingGroupName: 'Peak only',
    });
  });

  it('logs nothing when every group has a default', async () => {
    mockList.mockResolvedValue([]);
    const log = { warn: vi.fn() };
    expect(await reportPricingGroupsWithoutDefault(sql, log)).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('fails open when the check fails', async () => {
    mockList.mockRejectedValue(new Error('db down'));
    const log = { warn: vi.fn() };
    expect(await reportPricingGroupsWithoutDefault(sql, log)).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Pricing group default check failed; continuing',
    );
  });
});
