// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let returningRows: unknown[] = [];
const insertValues: Record<string, unknown>[] = [];
const updateSets: Record<string, unknown>[] = [];
const updateWheres: unknown[] = [];

function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['values'] = vi.fn((payload: Record<string, unknown>) => {
    insertValues.push(payload);
    return chain;
  });
  chain['returning'] = vi.fn(() => Promise.resolve(returningRows));
  return chain;
}

function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn((payload: Record<string, unknown>) => {
    updateSets.push(payload);
    return chain;
  });
  chain['where'] = vi.fn((cond: unknown) => {
    updateWheres.push(cond);
    return Promise.resolve();
  });
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    insert: vi.fn(() => makeInsertChain()),
    update: vi.fn(() => makeUpdateChain()),
  },
  workerJobLogs: { id: 'workerJobLogs.id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join('') })),
}));

describe('job-logger', () => {
  beforeEach(() => {
    returningRows = [];
    insertValues.length = 0;
    updateSets.length = 0;
    updateWheres.length = 0;
  });

  describe('logJobStarted', () => {
    it('inserts a started row and returns the new id', async () => {
      returningRows = [{ id: 99 }];
      const { logJobStarted } = await import('../job-logger.js');

      const id = await logJobStarted('reservation-activate', 'reservations');

      expect(id).toBe(99);
      expect(insertValues[0]).toEqual({
        jobName: 'reservation-activate',
        queue: 'reservations',
        status: 'started',
      });
    });

    it('throws when the insert returns no rows', async () => {
      returningRows = [];
      const { logJobStarted } = await import('../job-logger.js');

      await expect(logJobStarted('job', 'queue')).rejects.toThrow(
        'Failed to insert worker job log',
      );
    });
  });

  describe('logJobCompleted', () => {
    it('updates the row to completed with duration', async () => {
      const { eq } = await import('drizzle-orm');
      const { logJobCompleted } = await import('../job-logger.js');

      await logJobCompleted(5, 1234);

      expect(updateSets[0]).toMatchObject({ status: 'completed', durationMs: 1234 });
      expect(updateSets[0]?.['completedAt']).toBeDefined();
      expect(eq).toHaveBeenCalledWith('workerJobLogs.id', 5);
    });
  });

  describe('logJobFailed', () => {
    it('updates the row to failed with duration and error', async () => {
      const { eq } = await import('drizzle-orm');
      const { logJobFailed } = await import('../job-logger.js');

      await logJobFailed(8, 500, 'boom');

      expect(updateSets[0]).toMatchObject({
        status: 'failed',
        durationMs: 500,
        error: 'boom',
      });
      expect(updateSets[0]?.['completedAt']).toBeDefined();
      expect(eq).toHaveBeenCalledWith('workerJobLogs.id', 8);
    });

    it('truncates the error message to 5000 characters', async () => {
      const longError = 'x'.repeat(6000);
      const { logJobFailed } = await import('../job-logger.js');

      await logJobFailed(9, 100, longError);

      expect((updateSets[0]?.['error'] as string).length).toBe(5000);
    });
  });
});
