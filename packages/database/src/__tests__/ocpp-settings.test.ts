// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_PLAN_DEFAULTS } from '@evtivity/lib';

const mockWhere = vi.fn();
vi.mock('../config.js', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockWhere })) })) },
}));

import { clearDataPlanValuesCache, getDataPlanValues } from '../lib/ocpp-settings.js';

beforeEach(() => {
  clearDataPlanValuesCache();
  mockWhere.mockReset();
});

describe('getDataPlanValues', () => {
  it('reads the plan keys in one query and fills missing keys with the shipped values', async () => {
    mockWhere.mockResolvedValueOnce([
      { key: 'ocpp.cellular.heartbeatInterval', value: 7200 },
      { key: 'ocpp.cellular.dc.meterValueInterval', value: 90 },
    ]);
    const v = await getDataPlanValues('cellular');
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(v.heartbeatInterval).toBe(7200);
    expect(v.dc.meterValueInterval).toBe(90);
    expect(v.clockAlignedInterval).toBe(0);
    expect(v.ac).toEqual(DATA_PLAN_DEFAULTS.cellular.ac);
  });

  it('caches per plan', async () => {
    mockWhere.mockResolvedValue([{ key: 'ocpp.heartbeatInterval', value: 600 }]);
    await getDataPlanValues('wifi_or_wired');
    const again = await getDataPlanValues('wifi_or_wired');
    expect(again.heartbeatInterval).toBe(600);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    await getDataPlanValues('cellular');
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it('returns the shipped values when the read fails and nothing is cached', async () => {
    mockWhere.mockRejectedValueOnce(new Error('db down'));
    expect(await getDataPlanValues('wifi_or_wired')).toEqual(DATA_PLAN_DEFAULTS.wifi_or_wired);
  });
});
