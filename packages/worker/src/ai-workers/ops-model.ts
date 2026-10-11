// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one model call a background AI worker makes: a short plain-text
 * narrative over facts the worker computed itself. The `opsAi` surface
 * (system-initiated, no caller, so the company provider key), no tools,
 * capped output, the budget checked first and the usage recorded after.
 * The model never decides anything: proposals and findings are deterministic.
 */

import { resolveOpsAiConfig } from '@evtivity/services/ai-ops-config';
import type { OpsAiConfig } from '@evtivity/services/ai-ops-config';
import type { CheckAiBudgets } from '@evtivity/lib/ai-usage';
import type { AiWorkerJob } from '@evtivity/lib/ai-proposals';
import { aiUsageCostMicros } from '@evtivity/lib/pricing-engine';
import { checkAiBudgets, getAiSettings, recordAiUsage } from '@evtivity/database';
import { getModelEntry } from '@evtivity/ai/core';
import type { AiAdapter, ProviderId } from '@evtivity/ai/core';
import { getProviderRegistry } from '@evtivity/ai/providers';
import { frameUntrusted, promptLanguage } from '@evtivity/ai/prompt';
import {
  AI_USAGE_REDACTION_SURFACES,
  redactProviderRequest,
  redactToolValue,
} from '@evtivity/ai/redact';
import type { PromptLanguage } from '@evtivity/ai/prompt';
import { createLogger } from '@evtivity/lib';
import { opsSystemPrompt } from './prompts.js';

const log = createLogger('ai-worker-model');

/** A narrative the CSMS shows as plain text: never longer than this. */
export const MAX_NARRATIVE_CHARS = 1_500;
/**
 * Output budget of a worker model call. It covers a thinking model's
 * reasoning plus the text (`maxOutputTokens` in `@evtivity/ai`), so it is not
 * a length limit: `MAX_NARRATIVE_CHARS` is. DeepSeek spent whole budgets of
 * 120 and 700 tokens on reasoning and returned no text.
 */
export const OPS_MODEL_MAX_OUTPUT_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 60_000;

export interface OpsModelDeps {
  /** The budget check; default `checkAiBudgets` (tests pass a refusal). */
  checkBudgets?: CheckAiBudgets;
  /** Builds the adapter (tests pass a scripted one). */
  createAdapter?: (
    provider: ProviderId,
    options: { apiKey: string; baseUrl?: string },
  ) => AiAdapter;
  encryptionKey: string;
  allowPrivateHosts: boolean;
}

export type OpsNarrativeResult =
  | { kind: 'ok'; text: string; language: PromptLanguage; provider: ProviderId; model: string }
  /** `opsAi.enabled` is off. */
  | { kind: 'disabled' }
  /** No provider, key or valid base URL for the surface. */
  | { kind: 'not_configured' }
  | { kind: 'budget'; code: string }
  | { kind: 'error' };

function clean(text: string): string {
  const plain = text.replace(/\r/g, '').trim();
  return plain.length > MAX_NARRATIVE_CHARS ? `${plain.slice(0, MAX_NARRATIVE_CHARS)}...` : plain;
}

/**
 * Writes the narrative of one run. Every outcome but `ok` leaves the run with
 * its deterministic output only; the caller decides the run status.
 */
export async function runOpsNarrative(
  request: {
    job: AiWorkerJob;
    siteId: string | null;
    /** The `ai_worker_runs` row the call belongs to (ledger attribution). */
    workerRunId: number;
    facts: unknown;
  },
  deps: OpsModelDeps,
): Promise<OpsNarrativeResult> {
  const settings = await getAiSettings();
  if (!settings.ops.enabled) return { kind: 'disabled' };
  let config: OpsAiConfig | null;
  try {
    config = resolveOpsAiConfig(settings, deps.encryptionKey, deps.allowPrivateHosts);
  } catch (err) {
    // fail-open: a key that cannot be decrypted leaves the deterministic output (P9).
    log.warn({ err, job: request.job }, 'AI worker provider key could not be read');
    return { kind: 'error' };
  }
  if (config === null) return { kind: 'not_configured' };
  const { provider, model } = config;

  // Fail closed: a budget check that cannot run makes no model call (P9),
  // and the run keeps its deterministic output, as for a refusal.
  let decision: Awaited<ReturnType<CheckAiBudgets>>;
  try {
    decision = await (deps.checkBudgets ?? checkAiBudgets)({
      surface: 'worker',
      siteId: request.siteId,
    });
  } catch (err) {
    log.warn({ err, job: request.job, siteId: request.siteId }, 'AI budget check failed');
    return { kind: 'budget', code: 'AI_BUDGET_UNAVAILABLE' };
  }
  if (!decision.allowed) return { kind: 'budget', code: decision.code };

  const language = promptLanguage(settings.insights.primaryLanguage);
  const system = opsSystemPrompt(request.job, language, config.systemPrompt);
  const create =
    deps.createAdapter ??
    ((p: ProviderId, options: { apiKey: string; baseUrl?: string }) =>
      getProviderRegistry().create(p, options));
  try {
    const adapter = create(provider, {
      apiKey: config.apiKey,
      ...(config.baseUrl !== '' ? { baseUrl: config.baseUrl } : {}),
    });
    // The facts are aggregates and station ids the worker computed; they are
    // redacted by field like a tool result, then again at the boundary.
    const facts = JSON.stringify(
      redactToolValue(request.facts, AI_USAGE_REDACTION_SURFACES.worker).value,
    );
    const result = await adapter.complete(
      redactProviderRequest(
        {
          model,
          system: [{ text: system, cacheable: true }],
          messages: [
            {
              role: 'user',
              parts: [{ type: 'text', text: frameUntrusted('worker_facts', request.job, facts) }],
            },
          ],
          tools: [],
          effort: config.effort,
          maxOutputTokens: OPS_MODEL_MAX_OUTPUT_TOKENS,
          cacheKey: `ai-worker:${request.job}:${language}`,
        },
        'worker',
      ),
      AbortSignal.timeout(MODEL_TIMEOUT_MS),
    );
    try {
      const prices = getModelEntry(provider, model)?.prices ?? null;
      await recordAiUsage({
        surface: 'worker',
        siteId: request.siteId,
        workerRunId: String(request.workerRunId),
        provider,
        model,
        usage: result.usage,
        costMicros: prices === null ? null : aiUsageCostMicros(result.usage, prices),
      });
    } catch (err) {
      // fail-open: the call already ran; a lost ledger row is logged (P9).
      log.warn({ err, job: request.job, siteId: request.siteId }, 'AI worker usage not recorded');
    }
    const text = clean(result.text);
    if (text === '') return { kind: 'error' };
    return { kind: 'ok', text, language, provider, model };
  } catch (err) {
    // fail-open: the run keeps its deterministic output (P9).
    log.warn({ err, job: request.job, siteId: request.siteId }, 'AI worker model call failed');
    return { kind: 'error' };
  }
}
