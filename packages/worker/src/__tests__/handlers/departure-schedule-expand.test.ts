// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockList, mockExpand } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockExpand: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ listExpandableScheduleIds: mockList }));
vi.mock('@evtivity/services/departure.service', () => ({ expandScheduleOccurrences: mockExpand }));

import {
  departureScheduleExpandHandler,
  runDepartureScheduleExpand,
} from '../../handlers/departure-schedule-expand.js';

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockList.mockReset();
  mockExpand.mockReset();
});

describe('departure-schedule-expand', () => {
  it('expands every active schedule with the run time and counts what it created', async () => {
    const now = new Date('2026-11-01T03:00:00Z');
    mockList.mockResolvedValue(['vds_a', 'vds_b']);
    mockExpand.mockResolvedValueOnce([{ id: 'vdp_1' }, { id: 'vdp_2' }]).mockResolvedValueOnce([]);
    const result = await runDepartureScheduleExpand(makeLog(), now);
    expect(mockList).toHaveBeenCalledWith('2026-11-01');
    expect(mockExpand).toHaveBeenNthCalledWith(1, 'vds_a', now);
    expect(mockExpand).toHaveBeenNthCalledWith(2, 'vds_b', now);
    expect(result).toEqual({ schedules: 2, created: 2, errors: 0 });
  });

  it('logs a failed schedule and goes on with the others', async () => {
    mockList.mockResolvedValue(['vds_a', 'vds_b']);
    mockExpand
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce([{ id: 'x' }]);
    const log = makeLog();
    const result = await runDepartureScheduleExpand(log);
    expect(result).toEqual({ schedules: 2, created: 1, errors: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'vds_a' }),
      'Departure schedule not expanded, retried next run',
    );
  });

  it('logs the run at warn when a schedule failed', async () => {
    mockList.mockResolvedValue(['vds_a']);
    mockExpand.mockRejectedValue(new Error('boom'));
    const log = makeLog();
    await departureScheduleExpandHandler(log);
    expect(log.warn).toHaveBeenCalledWith(
      { schedules: 1, created: 0, errors: 1 },
      'Departure schedules expanded',
    );
  });
});
