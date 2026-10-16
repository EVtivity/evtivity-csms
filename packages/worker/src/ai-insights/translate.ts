// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Lazy translation of an insight summary (decision D2): the canonical text in
 * `aiInsights.primaryLanguage` is translated once per viewer language and
 * stored for every later viewer. The canonical text is model output built
 * from station data, so it reaches the translator framed as untrusted.
 * Over budget, or without a usable provider, the text is stored
 * `unavailable`: viewers get the structured fields and the original.
 */

import { dispatchAiBudgetNotices } from '@evtivity/services/ai-alerts';
import { recordAiUsage } from '@evtivity/database';
import { frameUntrusted } from '@evtivity/ai/prompt';
import { redactProviderRequest } from '@evtivity/ai/redact';
import { getModelEntry } from '@evtivity/ai/core';
import type { Logger } from '@evtivity/lib';
import { aiUsageCostMicros } from '@evtivity/lib/pricing-engine';
import { INSIGHT_TRANSLATION_MAX_LENGTH } from '@evtivity/lib/ai-insights';
import {
  getInsightRow,
  insightTexts,
  publishInsightUpdated,
  storeInsightTranslation,
} from '@evtivity/services/ai-insight.service';
import type { InsightJobDeps } from './generate.js';
import { INSIGHT_MAX_OUTPUT_TOKENS, kindEnabled, siteInsightsEnabled } from './generate.js';
import type { InsightKind } from '@evtivity/lib/ai-insights';
import { translationSystemBlocks } from './prompt.js';

const TRANSLATION_TIMEOUT_MS = 60_000;

export type TranslationOutcome = 'noop' | 'translated' | 'unavailable';

export async function translateInsight(
  insightId: string,
  language: string,
  deps: InsightJobDeps,
  log: Logger,
): Promise<TranslationOutcome> {
  const row = await getInsightRow(insightId);
  if (row == null) return 'noop';
  const texts = (await insightTexts([row], language)).get(insightId);
  if (texts?.requested?.status !== 'pending') return 'noop';
  const original = texts.primary?.status === 'ready' ? texts.primary.summary : null;

  const unavailable = async (): Promise<TranslationOutcome> => {
    if (await storeInsightTranslation(insightId, language, null)) {
      await publishInsightUpdated(deps.pubsub, row);
    }
    return 'unavailable';
  };
  if (original == null) return unavailable();

  // The same switches as a generation: a site or kind turned off pays for no
  // translation either.
  const settings = await deps.getSettings();
  if (
    !settings.ops.enabled ||
    !kindEnabled(row.kind as InsightKind, settings) ||
    !(await siteInsightsEnabled(row.siteId))
  ) {
    return unavailable();
  }
  const config = deps.resolveConfig(settings);
  if (config == null) return unavailable();
  // A provider out of credit or quota translates nothing until it answers again.
  if ((await deps.providerGate(config.provider)) === 'paused') return unavailable();
  const budget = await deps.checkBudgets({
    surface: 'insight_translation',
    siteId: row.siteId,
    now: deps.now(),
  });
  if (!budget.allowed) return unavailable();

  const adapter = deps.createAdapter(config);
  const result = await adapter.complete(
    redactProviderRequest(
      {
        model: config.model,
        system: translationSystemBlocks(language),
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: frameUntrusted('insight_summary', insightId, original) }],
          },
        ],
        tools: [],
        effort: 'low',
        maxOutputTokens: INSIGHT_MAX_OUTPUT_TOKENS,
        cacheKey: `insight-translation:${language}`,
      },
      'insight_translation',
    ),
    AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
  );
  const prices = getModelEntry(config.provider, config.model)?.prices ?? null;
  await dispatchAiBudgetNotices(
    await recordAiUsage({
      surface: 'insight_translation',
      insightId,
      siteId: row.siteId,
      userId: null,
      provider: config.provider,
      model: config.model,
      usage: result.usage,
      costMicros: prices == null ? null : aiUsageCostMicros(result.usage, prices),
    }),
  );
  const text = result.text.trim().slice(0, INSIGHT_TRANSLATION_MAX_LENGTH);
  if (text === '') {
    log.warn({ insightId, language }, 'Insight translation came back empty');
    return unavailable();
  }
  if (await storeInsightTranslation(insightId, language, text)) {
    await publishInsightUpdated(deps.pubsub, row);
  }
  return 'translated';
}
