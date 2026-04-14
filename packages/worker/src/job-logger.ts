// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, workerJobLogs } from '@evtivity/database';
import { eq, sql } from 'drizzle-orm';

export async function logJobStarted(jobName: string, queue: string): Promise<number> {
  const rows = await db
    .insert(workerJobLogs)
    .values({ jobName, queue, status: 'started' })
    .returning({ id: workerJobLogs.id });
  const row = rows[0];
  if (row == null) throw new Error('Failed to insert worker job log');
  return row.id;
}

export async function logJobCompleted(logId: number, durationMs: number): Promise<void> {
  await db
    .update(workerJobLogs)
    .set({ status: 'completed', durationMs, completedAt: sql`now()` })
    .where(eq(workerJobLogs.id, logId));
}

export async function logJobFailed(
  logId: number,
  durationMs: number,
  error: string,
): Promise<void> {
  await db
    .update(workerJobLogs)
    .set({
      status: 'failed',
      durationMs,
      error: error.slice(0, 5000),
      completedAt: sql`now()`,
    })
    .where(eq(workerJobLogs.id, logId));
}
