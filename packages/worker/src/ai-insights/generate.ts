// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Generates one automatic insight. Runs in
 * the worker (decision D1) through `@evtivity/ai`, with no tools: the model
 * reads only the evidence pack. Steps, cheapest first:
 *
 * 1. The insight must still be analyzing (P5: a closed insight is never revived).
 * 2. Switches: `opsAi.enabled`, the kind's switch, the site's switch.
 * 3. Debounce re-check: a station back online or no longer faulted ends
 *    `skipped/resolved_before_analysis` at zero cost.
 * 4. Known causes (`RULE_INSIGHTS`) get a rule insight, zero tokens. A
 *    reservation no-show is always a rule insight (decision E17).
 * 5. Site daily count cap, then the per-subject cooldown claim.
 * 6. The budget check (`CheckAiBudgets`); a refusal ends `budget_exceeded`.
 * 7. Evidence, deterministic scope (SQL), one model call with structured
 *    output where the model has it (prompted JSON otherwise), one repair
 *    retry, then the rule fallback of the kind. Each call records its usage.
 *    A regeneration's call also carries the requester's own wrong-vote note
 *    on the replaced insight, as untrusted operator feedback.
 *
 * A provider error throws: the job retries with backoff, and the queue's
 * final failure marks the insight `failed` (internal, never listed).
 */

import { dispatchAiBudgetNotices } from '@evtivity/services/ai-alerts';
import { client, recordAiUsage } from '@evtivity/database';
import type { AiUsageRecord } from '@evtivity/database';
import { aiUsageCostMicros } from '@evtivity/lib/pricing-engine';
import type { Logger, PubSubClient } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import {
  INSIGHT_KIND_FALLBACKS,
  insightAnswerProblem,
  isReservationInsightKind,
  RESERVATION_INSIGHT_ACTIONS,
  reservationAuditReason,
  reservationRuleInsightFor,
  ruleInsightFor,
  sanitizeInsightModelOutput,
} from '@evtivity/lib/ai-insights';
import type {
  InsightKind,
  InsightModelOutput,
  InsightScope,
  RuleInsight,
} from '@evtivity/lib/ai-insights';
import type { CheckAiBudgets } from '@evtivity/lib/ai-usage';
import { getModelEntry } from '@evtivity/ai/core';
import type { AiAdapter, AiMessage, AiRequest, ProviderId } from '@evtivity/ai/core';
import type { AiProviderGate } from '@evtivity/services/ai-alerts';
import { redactProviderRequest } from '@evtivity/ai/redact';
import {
  activateInsight,
  claimInsightCooldown,
  getInsightRow,
  publishInsightUpdated,
  regenerationFeedbackNote,
  skipInsight,
} from '@evtivity/services/ai-insight.service';
import type { AiInsightRow } from '@evtivity/services/ai-insight.service';
import {
  collectAttemptAuthorizationEvidence,
  collectReservationEvidence,
  collectSessionEvidence,
  collectSiteEvidence,
  collectStationEvidence,
  computeInsightScope,
  CONCURRENT_SESSION_FIXES,
  concurrentSessionOfAttempt,
  conditionCleared,
  currentFingerprint,
  evidenceIds,
  incidentMemberStationIds,
  renderEvidencePack,
  STATION_INSIGHT_KINDS,
} from '@evtivity/services/ai-evidence';
import type { EvidencePack } from '@evtivity/services/ai-evidence';
import type { OpsAiConfig } from '@evtivity/services/ai-ops-config';
import {
  INSIGHT_RESPONSE_SCHEMA,
  insightFeedbackBlock,
  insightRepairRequest,
  insightSystemBlocks,
  parseJsonAnswer,
} from './prompt.js';

/**
 * Output budget of an insight call. It covers a thinking
 * model's reasoning plus the JSON answer: DeepSeek spent all of 700 tokens on
 * reasoning and returned no text. The schema and the sanitizer bound the answer.
 */
export const INSIGHT_MAX_OUTPUT_TOKENS = 4096;
/** Wall clock of one model call. */
const MODEL_CALL_TIMEOUT_MS = 60_000;

export interface InsightJobDeps {
  getSettings: () => Promise<AiSettings>;
  resolveConfig: (settings: AiSettings) => OpsAiConfig | null;
  createAdapter: (config: OpsAiConfig) => AiAdapter;
  /** `checkAiBudgets` of `@evtivity/database`; tests pass a refusal. */
  checkBudgets: CheckAiBudgets;
  /** The provider quota alert gate (`aiProviderGate`); tests pass a state. */
  providerGate: (provider: ProviderId) => Promise<AiProviderGate>;
  pubsub: PubSubClient;
  now: () => Date;
  /** Keys the hashes of evidence values (`SETTINGS_ENCRYPTION_KEY`). */
  subjectSecret: string;
}

export type InsightJobOutcome = 'noop' | 'skipped' | 'rule' | 'model' | 'fallback' | 'closed';

export function kindEnabled(kind: InsightKind, settings: AiSettings): boolean {
  if (isReservationInsightKind(kind)) return settings.insights.reservationEnabled;
  if (STATION_INSIGHT_KINDS.has(kind) || kind === 'site_incident') {
    return settings.insights.stationEnabled;
  }
  if (kind === 'session_failed') return settings.insights.sessionEnabled;
  if (kind === 'authorization_refused') return settings.insights.authorizationEnabled;
  // Background worker suggestions follow their job's switch (translation only:
  // they are stored open by the worker, never generated here).
  if (kind === 'stuck_session') return settings.workers.stuckSessionsEnabled;
  if (kind === 'station_long_faulted' || kind === 'site_summary' || kind === 'company_summary') {
    return settings.workers.networkSummaryEnabled;
  }
  if (kind === 'tariff_anomaly') return settings.workers.tariffAnomaliesEnabled;
  return false;
}

export async function siteInsightsEnabled(siteId: string | null): Promise<boolean> {
  if (siteId == null) return true;
  const [row] = await client<{ enabled: boolean }[]>`
    SELECT ai_insights_enabled AS enabled FROM sites WHERE id = ${siteId}
  `;
  return row?.enabled ?? true;
}

/** Model insights generated for the site in the last 24 hours. */
async function modelInsightsToday(siteId: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_insights
    WHERE site_id = ${siteId} AND generated_by = 'model' AND created_at > now() - interval '24 hours'
  `;
  return row?.n ?? 0;
}

/** Regenerations an insight's trigger key is followed through to its scan trigger. */
const MAX_REGENERATION_HOPS = 10;

/**
 * The audit row id that raised a reservation insight: the trigger key is
 * `<kind>:<audit id>`; a regeneration (`regenerate:<old insight id>:<ts>`) is
 * followed back to the insight it replaced. Null when it cannot be found.
 */
async function reservationTriggerAuditId(row: AiInsightRow): Promise<number | null> {
  let key = row.triggerKey;
  for (let hop = 0; hop < MAX_REGENERATION_HOPS; hop++) {
    const audit = /^reservation_[a-z_]+:(\d+)$/.exec(key);
    if (audit?.[1] != null) return Number(audit[1]);
    const regenerated = /^regenerate:([^:]+):/.exec(key);
    if (regenerated?.[1] == null) return null;
    const [old] = await client<{ trigger_key: string }[]>`
      SELECT trigger_key FROM ai_insights WHERE id = ${regenerated[1]}
    `;
    if (old == null) return null;
    key = old.trigger_key;
  }
  return null;
}

/**
 * The rule of a reservation insight: the cause of the audit row that raised
 * it (a later row of the same action has its own insight). When that row
 * cannot be found, the newest row of the kind's action. A no-show is always a
 * rule insight (decision E17), the kind's fallback when the row is gone.
 */
async function reservationRule(row: AiInsightRow): Promise<RuleInsight | undefined> {
  const kind = row.kind as InsightKind;
  if (!isReservationInsightKind(kind) || row.reservationId == null) return undefined;
  const action = RESERVATION_INSIGHT_ACTIONS[kind];
  const auditId = await reservationTriggerAuditId(row);
  const [audit] =
    auditId != null
      ? await client<{ after: unknown }[]>`
          SELECT after FROM reservation_audit_log
          WHERE id = ${auditId} AND reservation_id = ${row.reservationId}
        `
      : await client<{ after: unknown }[]>`
          SELECT after FROM reservation_audit_log
          WHERE reservation_id = ${row.reservationId} AND action::text = ${action}
          ORDER BY id DESC LIMIT 1
        `;
  const rule = reservationRuleInsightFor(action, reservationAuditReason(audit?.after));
  if (rule == null && kind === 'reservation_no_show')
    return INSIGHT_KIND_FALLBACKS.reservation_no_show;
  return rule;
}

/** The fixed meaning of the subject, when it has one: a stop reason or a refused outcome. */
async function knownCause(row: AiInsightRow): Promise<string | null> {
  if (row.kind === 'session_failed' && row.sessionId != null) {
    const [s] = await client<{ stopped_reason: string | null }[]>`
      SELECT stopped_reason FROM charging_sessions WHERE id = ${row.sessionId}
    `;
    return s?.stopped_reason ?? null;
  }
  if (row.kind === 'authorization_refused' && row.authorizeAttemptId != null) {
    const [a] = await client<{ outcome: string }[]>`
      SELECT outcome::text AS outcome FROM authorize_attempts WHERE id = ${row.authorizeAttemptId}
    `;
    return a?.outcome ?? null;
  }
  return null;
}

interface CollectedEvidence {
  pack: EvidencePack;
  scope: InsightScope;
}

/** The evidence pack and scope of a subject; null when the subject is gone. */
export async function collectInsightEvidence(
  row: AiInsightRow,
  now: Date,
  subjectSecret: string,
): Promise<CollectedEvidence | null> {
  if (STATION_INSIGHT_KINDS.has(row.kind as InsightKind) && row.stationId != null) {
    const station = await collectStationEvidence(row.stationId, now);
    if (station == null) return null;
    const scope = await computeInsightScope({
      siteId: row.siteId,
      errorCode: station.errorCode,
    });
    return { pack: station.pack, scope };
  }
  if (row.kind === 'session_failed' && row.sessionId != null) {
    const session = await collectSessionEvidence(row.sessionId);
    if (session == null) return null;
    const scope = await computeInsightScope({
      siteId: row.siteId,
      stoppedReason: session.stoppedReason,
    });
    return { pack: session.pack, scope };
  }
  if (row.kind === 'authorization_refused' && row.authorizeAttemptId != null) {
    if (row.stationId == null) return null;
    const auth = await collectAttemptAuthorizationEvidence(
      row.authorizeAttemptId,
      row.stationId,
      row.subjectId,
    );
    if (auth == null) return null;
    const scope = await computeInsightScope({ siteId: row.siteId });
    return { pack: auth.pack, scope };
  }
  if (isReservationInsightKind(row.kind) && row.reservationId != null) {
    const reservation = await collectReservationEvidence(row.reservationId, subjectSecret, now);
    if (reservation == null) return null;
    const scope = await computeInsightScope({ siteId: row.siteId });
    return { pack: reservation.pack, scope };
  }
  if (row.kind === 'site_incident' && row.siteId != null) {
    const members = await incidentMemberStationIds(row.id);
    const site = await collectSiteEvidence(row.siteId, members, row.subjectId);
    const scope = await computeInsightScope({ siteId: row.siteId });
    return { pack: site.pack, scope };
  }
  return null;
}

function subjectRef(row: AiInsightRow) {
  return {
    id: row.id,
    kind: row.kind as InsightKind,
    stationId: row.stationId,
    sessionId: row.sessionId,
    authorizeAttemptId: row.authorizeAttemptId,
    reservationId: row.reservationId,
  };
}

async function finish(
  deps: InsightJobDeps,
  row: AiInsightRow,
  stored: boolean,
  outcome: InsightJobOutcome,
): Promise<InsightJobOutcome> {
  if (!stored) return 'closed';
  await publishInsightUpdated(deps.pubsub, { ...row, status: 'open' });
  return outcome;
}

async function skip(
  deps: InsightJobDeps,
  row: AiInsightRow,
  reason: Parameters<typeof skipInsight>[1],
  fields?: Parameters<typeof skipInsight>[2],
): Promise<InsightJobOutcome> {
  const skipped =
    fields === undefined
      ? await skipInsight(row.id, reason)
      : await skipInsight(row.id, reason, fields);
  if (skipped) {
    await publishInsightUpdated(deps.pubsub, { ...row, status: 'skipped' });
  }
  return 'skipped';
}

/**
 * Asks the model, with one repair retry. Returns the sanitized answer, or
 * null when both answers were unusable. Provider errors propagate.
 */
export async function askInsightModel(input: {
  adapter: AiAdapter;
  config: OpsAiConfig;
  kind: InsightKind;
  language: string;
  evidenceText: string;
  evidenceIds: ReadonlySet<string>;
  /**
   * A regeneration's operator feedback: the regenerating user's own note on
   * the insight it replaces (untrusted, framed and redacted by
   * `insightFeedbackBlock`). Rule insights never get here.
   */
  feedbackNote?: string | null;
  /** Runs the budget check; false refuses the call. */
  allowed: () => Promise<boolean>;
  /** The ledger row of each call, without its usage and cost. */
  ledger: Omit<AiUsageRecord, 'usage' | 'costMicros' | 'provider' | 'model'>;
  log: Logger;
}): Promise<{ answer: InsightModelOutput | null; refused: boolean; feedbackUsed: boolean }> {
  const prices = getModelEntry(input.config.provider, input.config.model)?.prices ?? null;
  const capabilities = input.adapter.capabilities(input.config.model);
  const feedback = insightFeedbackBlock(input.feedbackNote);
  const feedbackUsed = feedback != null;
  const userText = feedback == null ? input.evidenceText : `${input.evidenceText}\n\n${feedback}`;
  const messages: AiMessage[] = [{ role: 'user', parts: [{ type: 'text', text: userText }] }];
  const base: Omit<AiRequest, 'messages'> = {
    model: input.config.model,
    system: insightSystemBlocks(input.kind, input.language, input.config.systemPrompt),
    tools: [],
    effort: input.config.effort,
    maxOutputTokens: INSIGHT_MAX_OUTPUT_TOKENS,
    cacheKey: `insight:${input.kind}:${input.language}`,
    ...(capabilities.structuredOutput
      ? { responseSchema: { name: 'insight', schema: INSIGHT_RESPONSE_SCHEMA } }
      : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // The budget is checked before every model call, the repair retry included.
    if (!(await input.allowed())) return { answer: null, refused: attempt === 0, feedbackUsed };
    const signal = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
    const result = await input.adapter.complete(
      redactProviderRequest({ ...base, messages: [...messages] }, 'insight'),
      signal,
    );
    await dispatchAiBudgetNotices(
      await recordAiUsage({
        ...input.ledger,
        provider: input.config.provider,
        model: input.config.model,
        usage: result.usage,
        costMicros: prices == null ? null : aiUsageCostMicros(result.usage, prices),
      }),
    );
    const parsed = parseJsonAnswer(result.text);
    const answer = sanitizeInsightModelOutput(parsed, input.evidenceIds);
    if (answer != null) return { answer, refused: false, feedbackUsed };
    const empty = result.text.trim() === '';
    // Why the answer failed, never its text: the field, the issue, the length.
    const problem = empty
      ? 'the answer is empty'
      : parsed == null
        ? 'the answer holds no JSON object'
        : (insightAnswerProblem(parsed) ?? 'the answer does not have the required shape');
    input.log.debug(
      {
        insightId: input.ledger.insightId,
        kind: input.kind,
        attempt,
        problem,
        answerLength: result.text.length,
        outputTokens: result.usage.outputTokens,
      },
      'Insight model answer rejected',
    );
    // An empty answer is asked again unchanged: providers refuse an empty
    // assistant message (DeepSeek answers 400), which failed the insight.
    if (empty) continue;
    messages.push(
      { role: 'assistant', parts: [{ type: 'text', text: result.text.slice(0, 4000) }] },
      { role: 'user', parts: [{ type: 'text', text: insightRepairRequest(problem) }] },
    );
  }
  return { answer: null, refused: false, feedbackUsed };
}

/** Runs the generation of one insight. Idempotent: a closed insight is left alone. */
export async function generateInsight(
  insightId: string,
  deps: InsightJobDeps,
  log: Logger,
): Promise<InsightJobOutcome> {
  const row = await getInsightRow(insightId);
  if (row?.status !== 'analyzing') return 'noop';
  const kind = row.kind as InsightKind;
  const settings = await deps.getSettings();
  if (!settings.ops.enabled || !kindEnabled(kind, settings)) return skip(deps, row, 'disabled');
  if (!(await siteInsightsEnabled(row.siteId))) return skip(deps, row, 'site_disabled');
  if (await conditionCleared(subjectRef(row))) return skip(deps, row, 'resolved_before_analysis');

  const now = deps.now();
  const language = row.primaryLanguage;
  const cause = isReservationInsightKind(kind) ? null : await knownCause(row);
  const rule = isReservationInsightKind(kind) ? await reservationRule(row) : ruleInsightFor(cause);
  if (rule != null) {
    const evidence = await collectInsightEvidence(row, now, deps.subjectSecret);
    if (evidence == null) return skip(deps, row, 'resolved_before_analysis');
    let fixes = rule.fixes;
    let scope = evidence.scope;
    if (cause === 'concurrent_tx' && row.authorizeAttemptId != null) {
      // The fix follows the session the token already runs: a live charge is
      // never ended (wait, or a shared card); a stuck one gets the stuck-session step.
      const concurrent = await concurrentSessionOfAttempt(row.authorizeAttemptId, now);
      if (concurrent?.step == null) return skip(deps, row, 'resolved_before_analysis');
      fixes = CONCURRENT_SESSION_FIXES[concurrent.step];
      scope = {
        ...scope,
        concurrentSession: {
          sessionId: concurrent.sessionId,
          stationId: concurrent.stationId,
          station: concurrent.stationOcppId,
          startedAt: concurrent.startedAt?.toISOString() ?? null,
          step: concurrent.step,
        },
      };
    }
    const stored = await activateInsight(row.id, {
      category: rule.category,
      confidence: 'high',
      fixes: fixes.map((code) => ({ code })),
      evidenceRefs: [],
      scope,
      summary: null,
      language,
      generatedBy: 'rule',
      provider: null,
      model: null,
      basisAt: now,
      basisFingerprint: await currentFingerprint(subjectRef(row)),
    });
    return finish(deps, row, stored, 'rule');
  }

  if (row.siteId != null) {
    if ((await modelInsightsToday(row.siteId)) >= settings.insights.maxPerSitePerDay) {
      return skip(deps, row, 'site_daily_cap');
    }
  }
  const claimed = await claimInsightCooldown({
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    kind: row.kind,
    minutes: settings.insights.cooldownMinutes,
    insightId: row.id,
  });
  if (!claimed) return skip(deps, row, 'cooldown');

  const evidence = await collectInsightEvidence(row, now, deps.subjectSecret);
  if (evidence == null) return skip(deps, row, 'resolved_before_analysis');
  const basisFingerprint = await currentFingerprint(subjectRef(row));

  const config = deps.resolveConfig(settings);
  let answer: InsightModelOutput | null = null;
  let feedbackUsed = false;
  if (config != null && (await deps.providerGate(config.provider)) === 'paused') {
    // The provider account is out of credit or quota: skipped with the rule
    // fallback's fields, like a budget refusal; one probe per interval still runs.
    const fallback = INSIGHT_KIND_FALLBACKS[kind];
    return skip(deps, row, 'provider_paused', {
      category: fallback.category,
      confidence: 'low',
      fixes: fallback.fixes.map((code) => ({ code })),
      scope: evidence.scope,
    });
  }
  if (config == null) {
    log.warn({ insightId }, 'opsAi has no usable provider key; storing the rule fallback');
  } else {
    const rendered = renderEvidencePack(evidence.pack);
    // A regeneration reads the requester's own note on the replaced insight.
    const feedbackNote = await regenerationFeedbackNote(row);
    const asked = await askInsightModel({
      adapter: deps.createAdapter(config),
      config,
      kind,
      language,
      evidenceText: rendered.text,
      evidenceIds: evidenceIds(rendered.pack),
      feedbackNote,
      allowed: async () =>
        (
          await deps.checkBudgets({
            surface: 'insight',
            siteId: row.siteId,
            ...(row.requestedBy != null ? { userId: row.requestedBy } : {}),
            now: deps.now(),
          })
        ).allowed,
      ledger: {
        surface: 'insight',
        insightId,
        siteId: row.siteId,
        userId: row.requestedBy,
      },
      log,
    });
    if (asked.refused) {
      // Plan IN-06: skipped for the budget, with the rule fallback's fields.
      const fallback = INSIGHT_KIND_FALLBACKS[kind];
      return skip(deps, row, 'budget_exceeded', {
        category: fallback.category,
        confidence: 'low',
        fixes: fallback.fixes.map((code) => ({ code })),
        scope: evidence.scope,
      });
    }
    answer = asked.answer;
    feedbackUsed = asked.feedbackUsed;
  }

  if (answer == null) {
    const fallback = INSIGHT_KIND_FALLBACKS[kind];
    const stored = await activateInsight(row.id, {
      category: fallback.category,
      confidence: 'low',
      fixes: fallback.fixes.map((code) => ({ code })),
      evidenceRefs: [],
      scope: evidence.scope,
      summary: null,
      language,
      generatedBy: 'rule',
      provider: null,
      model: null,
      basisAt: now,
      basisFingerprint,
    });
    return finish(deps, row, stored, 'fallback');
  }

  const stored = await activateInsight(row.id, {
    category: answer.category,
    confidence: answer.confidence,
    fixes: answer.fixes,
    evidenceRefs: answer.evidenceRefs,
    // Counts come from SQL only: whatever the model wrote is never stored as scope.
    scope: evidence.scope,
    summary: answer.summary,
    language,
    generatedBy: 'model',
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    basisAt: now,
    basisFingerprint,
    feedbackUsed,
  });
  return finish(deps, row, stored, 'model');
}
