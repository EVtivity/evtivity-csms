// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * One run of a background AI worker job for one scope and period. Each run
 * claims its `ai_worker_runs` row first (one run per job, scope and period
 * across replicas), computes its facts with deterministic SQL, writes each
 * suggestion as an insight that carries an action (closed action set only,
 * `suggestWorkerAction`), and asks the model for a narrative only when the
 * surface, the job's switch and the budget allow it. Nothing here runs an
 * action: the worker holds no user credential and never imports the API's
 * executor (TC-AI-WK-06).
 */

import {
  getAiWorkerSettings,
  getOpsAiSettings,
  getStaleSessionTimeoutHours,
} from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { AI_PROPOSAL_TTL_MS } from '@evtivity/lib/ai-proposals';
import type { AiWorkerJob } from '@evtivity/lib/ai-proposals';
import { suggestWorkerAction } from '@evtivity/services/ai-workers/suggest';
import type { WorkerSuggestion } from '@evtivity/services/ai-workers/suggest';
import {
  COMPANY_SCOPE,
  claimAiWorkerRun,
  finishAiWorkerRun,
} from '@evtivity/services/ai-workers/runs';
import type { AiWorkerRunStatus } from '@evtivity/services/ai-workers/runs';
import {
  hasActivity,
  longFaultedStations,
  siteHealthMetrics,
} from '@evtivity/services/ai-workers/network-summary';
import {
  effectiveIdleMinutes,
  findStuckSessions,
} from '@evtivity/services/ai-workers/stuck-sessions';
import { tariffAnomalies } from '@evtivity/services/ai-workers/tariff-anomalies';
import { softResetProposal, stopSessionProposal } from '@evtivity/services/ai-workers/proposals';
import { runOpsNarrative } from './ops-model.js';
import { stuckSessionFacts } from './prompts.js';
import type { OpsModelDeps, OpsNarrativeResult } from './ops-model.js';

/** One queued run. `siteId` null with scope `unsited` or `company`. */
export interface AiWorkerJobData {
  job: AiWorkerJob;
  scope: string;
  siteId: string | null;
  period: string;
}

/**
 * Stores a worker narrative or findings as an insight (`site_summary`,
 * `company_summary`, `tariff_anomaly`) through the insight service of lane
 * R2. Returns the insight id. Until it is wired, runs keep their output in
 * `ai_worker_runs.output` only.
 */
export type AiWorkerInsightWriter = (input: {
  kind: 'site_summary' | 'company_summary' | 'tariff_anomaly';
  siteId: string | null;
  triggerKey: string;
  facts: unknown;
  narrative: Extract<OpsNarrativeResult, { kind: 'ok' }> | null;
}) => Promise<string | null>;

export interface AiWorkerDeps extends OpsModelDeps {
  writeInsight?: AiWorkerInsightWriter;
  now?: () => Date;
}

/** Most soft-reset suggestions one network summary run makes. */
export const MAX_SUMMARY_PROPOSALS = 3;
/** Most stuck-session rationales one run asks the model for. */
export const MAX_STUCK_RATIONALES = 10;

function runStatus(narrative: OpsNarrativeResult | null): AiWorkerRunStatus {
  return narrative?.kind === 'budget' ? 'budget_skipped' : 'completed';
}

function narrativeOutput(narrative: OpsNarrativeResult | null): Record<string, unknown> {
  if (narrative === null) return { narrative: null };
  if (narrative.kind !== 'ok') return { narrative: null, narrativeSkipped: narrative.kind };
  return {
    narrative: narrative.text,
    language: narrative.language,
    provider: narrative.provider,
    model: narrative.model,
  };
}

/** Writes each suggestion (an insight with its action); returns how many were created. */
async function propose(suggestions: WorkerSuggestion[], log: Logger): Promise<number> {
  let created = 0;
  for (const suggestion of suggestions) {
    try {
      if ((await suggestWorkerAction(suggestion, log)) === 'created') created += 1;
    } catch (err) {
      // fail-open: one target that cannot be suggested (station moved, session
      // ended) does not stop the run (P9).
      log.warn(
        { err, operationId: suggestion.action.operationId },
        'AI worker suggestion not created',
      );
    }
  }
  return created;
}

/**
 * Whether the job may run now. Checked again when a queued run starts, so a
 * job an operator turned off after the cron queued it does nothing (D4).
 */
async function jobEnabled(job: AiWorkerJob): Promise<boolean> {
  const [ops, workers] = await Promise.all([getOpsAiSettings(), getAiWorkerSettings()]);
  if (!ops.enabled) return false;
  if (job === 'network_summary') return workers.networkSummaryEnabled;
  if (job === 'stuck_sessions') return workers.stuckSessionsEnabled;
  return workers.tariffAnomaliesEnabled;
}

async function withRun(
  data: AiWorkerJobData,
  log: Logger,
  body: (runId: number) => Promise<Parameters<typeof finishAiWorkerRun>[1]>,
): Promise<void> {
  if (!(await jobEnabled(data.job))) {
    log.info({ ...data }, 'AI worker run skipped: the job is turned off');
    return;
  }
  const runId = await claimAiWorkerRun({
    job: data.job,
    scope: data.scope,
    siteId: data.siteId,
    period: data.period,
  });
  if (runId === null) {
    log.info({ ...data }, 'AI worker run already done for this period');
    return;
  }
  try {
    await finishAiWorkerRun(runId, await body(runId));
  } catch (err) {
    await finishAiWorkerRun(runId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Network health of one site, or of the company over every site's metrics. */
export async function runNetworkSummary(
  data: AiWorkerJobData,
  deps: AiWorkerDeps,
  log: Logger,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withRun(data, log, async (runId) => {
    if (data.scope === COMPANY_SCOPE) {
      const metrics = (await siteHealthMetrics({ now })).filter(hasActivity);
      if (metrics.length === 0) return { status: 'skipped', output: { sites: 0 } };
      const facts = { sites: metrics };
      const narrative = await runOpsNarrative(
        { job: 'network_summary', siteId: null, workerRunId: runId, facts },
        deps,
      );
      const insightId =
        (await deps.writeInsight?.({
          kind: 'company_summary',
          siteId: null,
          triggerKey: `network_summary:${data.period}`,
          facts,
          narrative: narrative.kind === 'ok' ? narrative : null,
        })) ?? null;
      return {
        status: runStatus(narrative),
        insightId,
        output: { ...facts, ...narrativeOutput(narrative) },
      };
    }

    const siteId = data.siteId;
    if (siteId === null) return { status: 'skipped' };
    const [metrics] = await siteHealthMetrics({ now, siteId });
    if (metrics === undefined || !hasActivity(metrics)) {
      return { status: 'skipped', output: { metrics: metrics ?? null } };
    }
    const settings = await getAiWorkerSettings();
    const expiresAt = new Date(now.getTime() + settings.proposalTtlHours * 3_600_000);
    const faulted = (await longFaultedStations({ siteId, now })).slice(0, MAX_SUMMARY_PROPOSALS);
    const facts = {
      metrics,
      faultedStations: faulted.map((s) => ({
        stationId: s.ocppStationId,
        faultedSince: s.faultedSince.toISOString(),
      })),
    };
    const narrative = await runOpsNarrative(
      { job: 'network_summary', siteId, workerRunId: runId, facts },
      deps,
    );
    const insightId =
      (await deps.writeInsight?.({
        kind: 'site_summary',
        siteId,
        triggerKey: `network_summary:${data.period}`,
        facts,
        narrative: narrative.kind === 'ok' ? narrative : null,
      })) ?? null;
    const proposalsCount = await propose(
      faulted.map((s) =>
        softResetProposal(s, { expiresAt, workerRunId: runId, period: data.period }),
      ),
      log,
    );
    return {
      status: runStatus(narrative),
      proposalsCount,
      insightId,
      output: { ...facts, ...narrativeOutput(narrative) },
    };
  });
}

/** Stop suggestions for the stuck sessions of one site (or of unsited stations). */
export async function runStuckSessions(
  data: AiWorkerJobData,
  deps: AiWorkerDeps,
  log: Logger,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withRun(data, log, async (runId) => {
    const settings = await getAiWorkerSettings();
    const staleTimeoutHours = await getStaleSessionTimeoutHours();
    const idleMinutes = effectiveIdleMinutes(settings.stuckSessionsIdleMinutes, staleTimeoutHours);
    if (idleMinutes !== settings.stuckSessionsIdleMinutes) {
      log.warn(
        { configured: settings.stuckSessionsIdleMinutes, used: idleMinutes, staleTimeoutHours },
        'Stuck-session idle time clamped below the stale-session timeout',
      );
    }
    const sessions = await findStuckSessions({
      idleMinutes,
      staleTimeoutHours,
      siteId: data.siteId,
    });
    if (sessions.length === 0) return { status: 'completed', output: { idleMinutes } };
    const expiresAt = new Date(now.getTime() + AI_PROPOSAL_TTL_MS.stuckSessions);
    const inputs: WorkerSuggestion[] = [];
    let budgetSkipped = false;
    let rationales = 0;
    for (const session of sessions) {
      const input = stopSessionProposal(session, {
        idleMinutes,
        expiresAt,
        workerRunId: runId,
        period: data.period,
        now,
      });
      if (input === null) continue;
      if (settings.stuckSessionsUseModel && !budgetSkipped && rationales < MAX_STUCK_RATIONALES) {
        rationales += 1;
        const narrative = await runOpsNarrative(
          {
            job: 'stuck_sessions',
            siteId: session.siteId,
            workerRunId: runId,
            facts: stuckSessionFacts(session, { idleMinutes, now }),
          },
          deps,
        );
        if (narrative.kind === 'budget') budgetSkipped = true;
        // The model rationale is the insight's text (translated like any insight).
        if (narrative.kind === 'ok') {
          const { text, language, provider, model } = narrative;
          input.insight.narrative = { text, language, provider, model };
        }
      }
      inputs.push(input);
    }
    const proposalsCount = await propose(inputs, log);
    return {
      status: budgetSkipped ? 'budget_skipped' : 'completed',
      proposalsCount,
      findingsCount: sessions.length,
      output: {
        idleMinutes,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          reason: s.reason,
          lastActivityAt: s.lastActivityAt.toISOString(),
        })),
      },
    };
  });
}

/** Tariff findings of one site. Findings only: never an action. */
export async function runTariffAnomalies(
  data: AiWorkerJobData,
  deps: AiWorkerDeps,
  log: Logger,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withRun(data, log, async (runId) => {
    const siteId = data.siteId;
    if (siteId === null) return { status: 'skipped' };
    const findings = await tariffAnomalies({ siteId, now });
    if (findings.length === 0) return { status: 'completed', output: { findings } };
    const facts = { findings: findings.map((f) => ({ type: f.type, count: f.count })) };
    const narrative = await runOpsNarrative(
      { job: 'tariff_anomalies', siteId, workerRunId: runId, facts },
      deps,
    );
    const insightId =
      (await deps.writeInsight?.({
        kind: 'tariff_anomaly',
        siteId,
        triggerKey: `tariff_anomalies:${data.period}`,
        facts: { findings },
        narrative: narrative.kind === 'ok' ? narrative : null,
      })) ?? null;
    return {
      status: runStatus(narrative),
      findingsCount: findings.reduce((n, f) => n + f.count, 0),
      insightId,
      output: { findings, ...narrativeOutput(narrative) },
    };
  });
}

export const AI_WORKER_RUNNERS: Readonly<
  Record<AiWorkerJob, (data: AiWorkerJobData, deps: AiWorkerDeps, log: Logger) => Promise<void>>
> = {
  network_summary: runNetworkSummary,
  stuck_sessions: runStuckSessions,
  tariff_anomalies: runTariffAnomalies,
};
