// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * One driver AI support analysis (plan v0.1.45, section 2.2 step 4). Runs in
 * the worker (decision E2) through `@evtivity/ai`, with no tools: the model
 * reads only the case's evidence pack. Checks, cheapest first, each ending
 * the AI step and handing the case to operators:
 *
 * 1. The case is still `queued` in `ai_assist` (else nothing to do, P7).
 * 2. `driverAi.enabled` (skipped/disabled).
 * 3. Stored consent granted under a released notice version (failed, P11
 *    layer 3, TC-AI-DR-09).
 * 4. The driver is active (skipped/driver_inactive, threat T8).
 * 5. The driver's AI cases today, in the system timezone, within
 *    `driverAi.maxCasesPerDriverPerDay` (skipped/driver_limit).
 * 6. Budgets: company monthly, the case station's site monthly, driver daily
 *    (skipped/budget_exceeded, decision E10).
 * 7. A usable provider (skipped/disabled: the surface is not configured).
 *
 * Then the case is claimed (`queued -> analyzing`, compare-and-set, so one
 * job runs the call), the evidence collected (skipped/no_evidence when the
 * case lost its driver), and one model call made with structured output when
 * the model has it, prompted JSON otherwise. An answer that fails the output
 * checks gets one repair retry naming the problem, then failed/invalid_output.
 * The budget is checked before each call, and each call writes a ledger row.
 *
 * A provider error puts the case back to `queued` and throws, so the job
 * retries with backoff; after the last attempt the queue's failure handler
 * ends it failed/provider_error, with no answer stored (TC-AI-DR-24).
 */

import { client, recordAiUsage } from '@evtivity/database';
import { isUiLanguage, isValidTimezone } from '@evtivity/lib';
import type { Logger } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import { driverAiAnswerProblem, driverAiAnswerSchema } from '@evtivity/lib/driver-ai';
import type { DriverAiStateReason } from '@evtivity/lib/driver-ai';
import type { CheckAiBudgets } from '@evtivity/lib/ai-usage';
import { aiUsageCostMicros } from '@evtivity/lib/pricing-engine';
import { getModelEntry } from '@evtivity/ai/core';
import type { AiAdapter, AiMessage, AiRequest } from '@evtivity/ai/core';
import { promptLanguage } from '@evtivity/ai/prompt';
import { redactProviderRequest } from '@evtivity/ai/redact';
import { collectDriverSupportEvidence, renderEvidencePack } from '@evtivity/services/ai-evidence';
import { DRIVER_AI_MAX_OUTPUT_TOKENS } from '@evtivity/services/driver-ai-config';
import type { DriverAiConfig } from '@evtivity/services/driver-ai-config';
import {
  claimDriverAiAnalysis,
  escalateFromAi,
  getSupportCaseRow,
  requeueStuckDriverAiAnalysis,
  storeDriverAiAnswer,
} from '@evtivity/services/support-case.service';
import type { EscalateFromAiInput } from '@evtivity/services/support-case.service';
import { parseJsonAnswer } from '../ai-insights/prompt.js';
import { assertDriverAiConsent, hasDriverAiConsent } from './consent.js';
import {
  DRIVER_AI_RESPONSE_SCHEMA,
  driverAiRepairRequest,
  driverAiSystemBlocks,
} from './prompt.js';

/** Wall clock of one model call. */
const MODEL_CALL_TIMEOUT_MS = 60_000;
/** About 4k input tokens of evidence at 4 characters a token (plan 2.5). */
export const DRIVER_EVIDENCE_MAX_CHARS = 16_000;

export interface DriverAiJobDeps {
  getSettings: () => Promise<AiSettings>;
  resolveConfig: (settings: AiSettings) => DriverAiConfig | null;
  createAdapter: (config: DriverAiConfig) => AiAdapter;
  /** `checkAiBudgets` of `@evtivity/database`; tests pass a refusal. */
  checkBudgets: CheckAiBudgets;
  /** The system timezone of the per-driver daily case cap. */
  systemTimezone: () => Promise<string>;
  now: () => Date;
}

export type DriverAiJobOutcome = 'noop' | 'skipped' | 'failed' | 'answered';

interface DriverRow {
  is_active: boolean;
  language: string | null;
}

async function loadDriver(driverId: string): Promise<DriverRow | undefined> {
  const [row] = await client<DriverRow[]>`
    SELECT is_active, language FROM drivers WHERE id = ${driverId}
  `;
  return row;
}

/** AI cases the driver started today (consent granted), in the system timezone. */
export async function driverAiCasesToday(driverId: string, timeZone: string): Promise<number> {
  const zone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const [row] = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM support_cases
    WHERE driver_id = ${driverId} AND ai_consent = 'granted'
      AND ai_consent_at >= (date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})
  `;
  return row?.n ?? 0;
}

async function caseSiteId(stationId: string | null): Promise<string | null> {
  if (stationId == null) return null;
  const [row] = await client<{ site_id: string | null }[]>`
    SELECT site_id FROM charging_stations WHERE id = ${stationId}
  `;
  return row?.site_id ?? null;
}

/**
 * The answer language: the driver's language when it is a UI language, else
 * the language the consent notice was shown in (TC-AI-DR-26).
 */
export function driverAiLanguage(
  driverLanguage: string | null | undefined,
  consentLanguage: string | null | undefined,
): string {
  if (isUiLanguage(driverLanguage)) return driverLanguage;
  return promptLanguage(consentLanguage);
}

/**
 * Asks the model, with one repair retry. Returns the validated answer, or why
 * there is none. Provider errors propagate.
 */
export async function askDriverAiModel(input: {
  adapter: AiAdapter;
  config: DriverAiConfig;
  language: string;
  evidenceText: string;
  /** Runs the budget check; false refuses the call. */
  allowed: () => Promise<boolean>;
  ledger: { driverId: string; siteId: string | null; supportCaseId: string };
  log: Logger;
}): Promise<
  | { answer: ReturnType<typeof driverAiAnswerSchema.parse> }
  | { answer: null; reason: Extract<DriverAiStateReason, 'budget_exceeded' | 'invalid_output'> }
> {
  const prices = getModelEntry(input.config.provider, input.config.model)?.prices ?? null;
  const capabilities = input.adapter.capabilities(input.config.model);
  const messages: AiMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: input.evidenceText }] },
  ];
  const base: Omit<AiRequest, 'messages'> = {
    model: input.config.model,
    system: driverAiSystemBlocks(input.language, input.config.systemPrompt),
    tools: [],
    effort: input.config.effort,
    maxOutputTokens: DRIVER_AI_MAX_OUTPUT_TOKENS,
    cacheKey: `driver-ai:${promptLanguage(input.language)}`,
    ...(capabilities.structuredOutput
      ? { responseSchema: { name: 'driver_answer', schema: DRIVER_AI_RESPONSE_SCHEMA } }
      : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // The budget is checked before every model call, the repair retry included.
    // A refusal ends the step as budget_exceeded, the repair retry included.
    if (!(await input.allowed())) return { answer: null, reason: 'budget_exceeded' };
    const signal = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
    // Provider boundary redaction (TC-AI-AD-10): the driver surface level.
    const result = await input.adapter.complete(
      redactProviderRequest({ ...base, messages: [...messages] }, 'driver_support'),
      signal,
    );
    await recordAiUsage({
      surface: 'driver_support',
      driverId: input.ledger.driverId,
      siteId: input.ledger.siteId,
      supportCaseId: input.ledger.supportCaseId,
      provider: input.config.provider,
      model: input.config.model,
      usage: result.usage,
      costMicros: prices == null ? null : aiUsageCostMicros(result.usage, prices),
    });
    const empty = result.text.trim() === '';
    const parsed = empty ? null : parseJsonAnswer(result.text);
    const problem = empty
      ? 'the answer is empty'
      : parsed == null
        ? 'the answer holds no JSON object'
        : driverAiAnswerProblem(parsed);
    if (problem == null) return { answer: driverAiAnswerSchema.parse(parsed) };
    // Why the answer failed, never its text.
    input.log.debug(
      { caseId: input.ledger.supportCaseId, attempt, problem, answerLength: result.text.length },
      'Driver AI answer rejected',
    );
    // An empty answer is asked again unchanged (providers refuse an empty
    // assistant message).
    if (empty) continue;
    messages.push(
      { role: 'assistant', parts: [{ type: 'text', text: result.text.slice(0, 4000) }] },
      { role: 'user', parts: [{ type: 'text', text: driverAiRepairRequest(problem) }] },
    );
  }
  return { answer: null, reason: 'invalid_output' };
}

/** Runs the analysis of one case. Idempotent: a case not `queued` is left alone. */
export async function analyzeDriverAiCase(
  caseId: string,
  deps: DriverAiJobDeps,
  log: Logger,
): Promise<DriverAiJobOutcome> {
  const row = await getSupportCaseRow(caseId);
  if (row?.status !== 'ai_assist' || row.aiState !== 'queued') return 'noop';

  const end = async (
    from: EscalateFromAiInput['from'],
    state: 'skipped' | 'failed',
    reason: DriverAiStateReason | null,
  ): Promise<DriverAiJobOutcome> => {
    await escalateFromAi({ caseId, from, state, reason, log });
    return state;
  };

  const settings = await deps.getSettings();
  if (!settings.driver.enabled) return end(['queued'], 'skipped', 'disabled');
  if (!hasDriverAiConsent(row) || row.driverId == null) {
    log.error({ caseId }, 'Driver AI case without valid consent; sent to operators');
    return end(['queued'], 'failed', null);
  }
  const driverId = row.driverId;
  const driver = await loadDriver(driverId);
  if (driver?.is_active !== true) return end(['queued'], 'skipped', 'driver_inactive');
  const casesToday = await driverAiCasesToday(driverId, await deps.systemTimezone());
  if (casesToday > settings.driver.maxCasesPerDriverPerDay) {
    return end(['queued'], 'skipped', 'driver_limit');
  }
  const siteId = await caseSiteId(row.stationId);
  const budgetAllowed = async (): Promise<boolean> =>
    (await deps.checkBudgets({ surface: 'driver_support', driverId, siteId, now: deps.now() }))
      .allowed;
  if (!(await budgetAllowed())) return end(['queued'], 'skipped', 'budget_exceeded');
  const config = deps.resolveConfig(settings);
  if (config == null) {
    log.warn({ caseId }, 'driverAi has no usable provider key; sent to operators');
    return end(['queued'], 'skipped', 'disabled');
  }

  if (!(await claimDriverAiAnalysis(caseId))) return 'noop';

  const pack = await collectDriverSupportEvidence(caseId);
  if (pack == null) return end(['analyzing'], 'skipped', 'no_evidence');
  // Re-read the case right before the call (P11 layer 3): consent and state.
  const current = await getSupportCaseRow(caseId);
  if (current?.aiState !== 'analyzing') return 'noop';
  assertDriverAiConsent(caseId, current);

  const rendered = renderEvidencePack(pack, DRIVER_EVIDENCE_MAX_CHARS, 'driver');
  let asked: Awaited<ReturnType<typeof askDriverAiModel>>;
  try {
    asked = await askDriverAiModel({
      adapter: deps.createAdapter(config),
      config,
      language: driverAiLanguage(driver.language, current.aiConsentLanguage),
      evidenceText: rendered.text,
      allowed: budgetAllowed,
      ledger: { driverId, siteId, supportCaseId: caseId },
      log,
    });
  } catch (err) {
    // Back to queued so the retry claims it again (one call per attempt).
    await requeueStuckDriverAiAnalysis(caseId, new Date(Date.now() + 60_000));
    throw err;
  }
  if (asked.answer == null) {
    return end(
      ['analyzing'],
      asked.reason === 'budget_exceeded' ? 'skipped' : 'failed',
      asked.reason,
    );
  }
  const stored = await storeDriverAiAnswer({
    caseId,
    answer: asked.answer.answer,
    driverActions: asked.answer.driverActions,
    needsOperator: asked.answer.needsOperator,
    provider: config.provider,
    model: config.model,
    log,
  });
  return stored ? 'answered' : 'noop';
}

/** After the last attempt of a job: the case goes to operators as failed/provider_error. */
export async function failDriverAiCase(caseId: string, log: Logger): Promise<boolean> {
  return escalateFromAi({
    caseId,
    from: ['queued', 'analyzing'],
    state: 'failed',
    reason: 'provider_error',
    log,
  });
}
