// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Background AI worker runs: the only writer of `ai_worker_runs` (P3). A run
 * is claimed by inserting its (job, scope, period) row; a second replica or a
 * retried job finds the row and does nothing (P7, TC-AI-WK-15).
 */

import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { db, aiWorkerRuns } from '@evtivity/database';
import type { AiWorkerJob } from '@evtivity/lib/ai-proposals';

export type AiWorkerRunStatus = 'completed' | 'failed' | 'skipped' | 'budget_skipped';

/** The worker jobs plus the daily digest, which claims its day the same way. */
export type AiWorkerRunJob = AiWorkerJob | 'proposal_digest';

/** The scope key of a run: a site id, `unsited` for stations without a site, or `company`. */
export type AiWorkerScope = string;
export const COMPANY_SCOPE = 'company';
export const UNSITED_SCOPE = 'unsited';

export function scopeOfSite(siteId: string | null): AiWorkerScope {
  return siteId ?? UNSITED_SCOPE;
}

/** The day (UTC) of `now`: the period of the daily jobs. */
export function dayPeriod(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The 15-minute slot (UTC) of `now`: the period of the stuck-session job. */
export function quarterHourPeriod(now: Date): string {
  const slot = new Date(now);
  slot.setUTCMinutes(Math.floor(slot.getUTCMinutes() / 15) * 15, 0, 0);
  return slot.toISOString().slice(0, 16);
}

/**
 * Claims the run, or returns null when this job, scope and period already ran
 * or runs. A `failed` run of the period can be claimed again (a later tick or
 * a manual run retries it); a `running` row left by a crash keeps its period.
 */
export async function claimAiWorkerRun(input: {
  job: AiWorkerRunJob;
  scope: AiWorkerScope;
  siteId: string | null;
  period: string;
}): Promise<number | null> {
  const [row] = await db
    .insert(aiWorkerRuns)
    .values({
      job: input.job,
      scopeKey: input.scope,
      siteId: input.siteId,
      period: input.period,
      status: 'running',
    })
    .onConflictDoUpdate({
      target: [aiWorkerRuns.job, aiWorkerRuns.scopeKey, aiWorkerRuns.period],
      set: {
        status: 'running',
        error: null,
        finishedAt: null,
        startedAt: sql`now()`,
        proposalsCount: 0,
        findingsCount: 0,
      },
      setWhere: sql`${aiWorkerRuns.status} = 'failed'`,
    })
    .returning({ id: aiWorkerRuns.id });
  return row?.id ?? null;
}

/** Ends a running run. Only a `running` row changes (P5). */
export async function finishAiWorkerRun(
  id: number,
  result: {
    status: AiWorkerRunStatus;
    proposalsCount?: number;
    findingsCount?: number;
    insightId?: string | null;
    output?: unknown;
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(aiWorkerRuns)
    .set({
      status: result.status,
      proposalsCount: result.proposalsCount ?? 0,
      findingsCount: result.findingsCount ?? 0,
      insightId: result.insightId ?? null,
      output: result.output ?? null,
      error: result.error == null ? null : result.error.slice(0, 1000),
      finishedAt: sql`now()`,
    })
    .where(and(eq(aiWorkerRuns.id, id), eq(aiWorkerRuns.status, 'running')));
}

/** A run still `running` after this long died with its process (runs last minutes). */
export const AI_WORKER_RUN_TIMEOUT_MINUTES = 60;

/**
 * Marks runs still `running` past the timeout as `failed` (compare-and-set
 * on `running`), so the next tick or a manual run can claim their period
 * again. Called by the `ai-proposal-sweep` cron. Returns the count.
 */
export async function failStaleAiWorkerRuns(
  timeoutMinutes = AI_WORKER_RUN_TIMEOUT_MINUTES,
): Promise<number> {
  const rows = await db
    .update(aiWorkerRuns)
    .set({ status: 'failed', error: 'interrupted', finishedAt: sql`now()` })
    .where(
      and(
        eq(aiWorkerRuns.status, 'running'),
        lt(aiWorkerRuns.startedAt, sql`now() - ${timeoutMinutes} * interval '1 minute'`),
      ),
    )
    .returning({ id: aiWorkerRuns.id });
  return rows.length;
}

/** Deletes finished runs older than `retentionDays` (cron `ai-retention-prune`). */
export async function pruneAiWorkerRuns(retentionDays: number): Promise<number> {
  const rows = await db
    .delete(aiWorkerRuns)
    .where(
      and(
        ne(aiWorkerRuns.status, 'running'),
        lt(aiWorkerRuns.startedAt, sql`now() - ${retentionDays} * interval '1 day'`),
      ),
    )
    .returning({ id: aiWorkerRuns.id });
  return rows.length;
}
