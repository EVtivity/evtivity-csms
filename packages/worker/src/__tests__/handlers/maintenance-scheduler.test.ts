// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Drizzle chain mock. Queries run in order: dueScheduled SELECT, dueEnd SELECT.
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  let awaited = false;
  chain['then'] = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ): Promise<unknown> => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  maintenanceEvents: {
    id: 'maintenanceEvents.id',
    status: 'maintenanceEvents.status',
    plannedStartAt: 'maintenanceEvents.plannedStartAt',
    plannedEndAt: 'maintenanceEvents.plannedEndAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...c: unknown[]) => ({ and: c })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  lte: vi.fn((col: unknown, val: unknown) => ({ lte: [col, val] })),
  sql: Object.assign((strings: TemplateStringsArray) => ({ sql: strings.join('') }), {
    raw: vi.fn(),
  }),
}));

const mockEnter = vi.fn().mockResolvedValue(undefined);
const mockExit = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/services/maintenance.service.js', () => ({
  enterMaintenance: (...args: unknown[]) => mockEnter(...args),
  exitMaintenance: (...args: unknown[]) => mockExit(...args),
}));

const SYSTEM_ACTOR = { type: 'system', label: 'maintenance-scheduler' };

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('maintenanceSchedulerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    mockEnter.mockReset();
    mockExit.mockReset();
    mockEnter.mockResolvedValue(undefined);
    mockExit.mockResolvedValue(undefined);
  });

  it('does nothing and logs a zero tick when no windows are due', async () => {
    setupDbResults([], []);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    expect(mockEnter).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ activated: 0, ended: 0 }, 'maintenance-scheduler tick');
  });

  it('activates every due scheduled window via enterMaintenance with the system actor', async () => {
    setupDbResults([{ id: 'mne_1' }, { id: 'mne_2' }], []);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    expect(mockEnter).toHaveBeenCalledTimes(2);
    expect(mockEnter).toHaveBeenNthCalledWith(1, 'mne_1', SYSTEM_ACTOR, log);
    expect(mockEnter).toHaveBeenNthCalledWith(2, 'mne_2', SYSTEM_ACTOR, log);
    expect(mockExit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ activated: 2, ended: 0 }, 'maintenance-scheduler tick');
  });

  it('ends every due active window via exitMaintenance with the system actor', async () => {
    setupDbResults([], [{ id: 'mne_end_1' }, { id: 'mne_end_2' }]);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    expect(mockExit).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenNthCalledWith(1, 'mne_end_1', SYSTEM_ACTOR, log);
    expect(mockExit).toHaveBeenNthCalledWith(2, 'mne_end_2', SYSTEM_ACTOR, log);
    expect(mockEnter).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ activated: 0, ended: 2 }, 'maintenance-scheduler tick');
  });

  it('handles both activation and ending in the same tick', async () => {
    setupDbResults([{ id: 'mne_start' }], [{ id: 'mne_stop' }]);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    expect(mockEnter).toHaveBeenCalledWith('mne_start', SYSTEM_ACTOR, log);
    expect(mockExit).toHaveBeenCalledWith('mne_stop', SYSTEM_ACTOR, log);
    expect(log.info).toHaveBeenCalledWith({ activated: 1, ended: 1 }, 'maintenance-scheduler tick');
  });

  it('warns and continues when enterMaintenance throws for one event (fail-open)', async () => {
    setupDbResults([{ id: 'mne_bad' }, { id: 'mne_good' }], []);
    const err = new Error('enter blew up');
    mockEnter.mockRejectedValueOnce(err);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    // Second event still processed despite the first throwing.
    expect(mockEnter).toHaveBeenCalledTimes(2);
    expect(mockEnter).toHaveBeenNthCalledWith(2, 'mne_good', SYSTEM_ACTOR, log);
    expect(log.warn).toHaveBeenCalledWith(
      { err, eventId: 'mne_bad' },
      'maintenance-scheduler: enterMaintenance failed',
    );
    // Count reflects the rows selected, not the successes.
    expect(log.info).toHaveBeenCalledWith({ activated: 2, ended: 0 }, 'maintenance-scheduler tick');
  });

  it('warns and continues when exitMaintenance throws for one event (fail-open)', async () => {
    setupDbResults([], [{ id: 'mne_bad_end' }, { id: 'mne_good_end' }]);
    const err = new Error('exit blew up');
    mockExit.mockRejectedValueOnce(err);

    const { maintenanceSchedulerHandler } = await import('../../handlers/maintenance-scheduler.js');
    await maintenanceSchedulerHandler(log);

    expect(mockExit).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenNthCalledWith(2, 'mne_good_end', SYSTEM_ACTOR, log);
    expect(log.warn).toHaveBeenCalledWith(
      { err, eventId: 'mne_bad_end' },
      'maintenance-scheduler: exitMaintenance failed',
    );
  });
});
