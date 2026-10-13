// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Insight prompts. The system prompt is a
 * static, cacheable block per kind and language: the security rules, the
 * kind's task and the answer contract are always added; the surface prompt
 * is the built-in ops prompt or the operator's `opsAi.systemPrompt` (P1). The evidence
 * goes into the user message, station-supplied text framed as untrusted.
 */

import type { AiSystemBlock } from '@evtivity/ai/core';
import { tryParseJson } from '@evtivity/lib';
import { LANGUAGE_NAMES, promptLanguage, terminologyNote } from '@evtivity/ai/prompt';
import {
  FIX_CODES,
  INSIGHT_CONFIDENCES,
  INSIGHT_FIX_NOTE_MAX_LENGTH,
  INSIGHT_MAX_FIXES,
  INSIGHT_SUMMARY_MAX_LENGTH,
  ROOT_CAUSE_CATEGORIES,
} from '@evtivity/lib/ai-insights';
import type { InsightKind } from '@evtivity/lib/ai-insights';
import { defaultOpsPrompt, OPS_SECURITY_RULES } from '@evtivity/services/ai-ops-prompt';

const KIND_TASKS: Record<InsightKind, string> = {
  station_offline: 'A charging station went offline. Find the most likely root cause.',
  station_faulted:
    'A charging station or one of its connectors reported a fault. Find the most likely root cause.',
  station_alert:
    'A charging station raised a critical event alert. Explain what it most likely means.',
  session_failed: 'A charging session ended failed or faulted. Find the most likely root cause.',
  authorization_refused:
    'A driver token was refused at a charging station, possibly several times. Find the most likely root cause.',
  site_incident:
    'Several charging stations of one site went offline or faulted at about the same time. Find the most likely common root cause.',
  site_summary: 'Summarize the state of one site.',
  company_summary: 'Summarize the state of the charging network.',
  tariff_anomaly: 'Explain a tariff anomaly.',
  // Worker suggestions are stored by the worker, never generated: listed for completeness.
  stuck_session: 'A charging session looks stuck. Explain why stopping it may be needed.',
  station_long_faulted:
    'A charging station has been faulted for hours. Explain why a soft reset may help.',
  reservation_rejected:
    'A charging station rejected a reservation, or did not answer the reservation request. Find the most likely root cause.',
  reservation_no_show:
    'A driver did not use an accepted reservation before it expired. Find the most likely root cause.',
  reservation_cancel_failed:
    'A charging station did not cancel a reservation the CSMS cancelled. Find the most likely root cause.',
  reservation_fee_failed:
    'A reservation fee (cancellation or no-show) could not be charged. Find the most likely root cause.',
  reservation_station_faulted:
    'A charging station went offline or faulted while it held a reservation, and the reservation was cancelled. Find the most likely root cause.',
};

/** The task of one insight kind; always added after the surface prompt. */
export function insightTask(kind: InsightKind): string {
  return KIND_TASKS[kind];
}

/**
 * The summary length the prompt asks for, two thirds of the hard limit. Models
 * count characters loosely: asked for "at most 600", DeepSeek wrote 609 to 768
 * characters in 9 of 19 first answers, each rejected and asked again
 * (2026-10-11). The validation limit stays `INSIGHT_SUMMARY_MAX_LENGTH`.
 */
export const INSIGHT_SUMMARY_TARGET_LENGTH = Math.floor((INSIGHT_SUMMARY_MAX_LENGTH * 2) / 3);

/**
 * How to pick the root cause. Without it models answered `unknown` for about
 * one session failure in six although the evidence named a cause, and the
 * insights list showed no root cause for them.
 */
export const INSIGHT_CATEGORY_RULE =
  'Pick the category the evidence points to most, even when the evidence is incomplete, and say how sure you are with "confidence". Answer "unknown" only when no evidence item points to any category, and then set "confidence" to "low".';

/** The JSON answer contract: closed category and fix code lists. */
export function insightAnswerContract(language: string): string {
  const lang = promptLanguage(language);
  return [
    'Answer with one JSON object and nothing else:',
    `{"category": one of ${JSON.stringify(ROOT_CAUSE_CATEGORIES)},`,
    ` "confidence": one of ${JSON.stringify(INSIGHT_CONFIDENCES)},`,
    ` "summary": plain text in ${LANGUAGE_NAMES[lang]}, 2 or 3 short sentences of about ${String(INSIGHT_SUMMARY_TARGET_LENGTH)} characters; an answer with a summary over ${String(INSIGHT_SUMMARY_MAX_LENGTH)} characters is rejected,`,
    ` "fixes": at most ${String(INSIGHT_MAX_FIXES)} objects {"code": one of ${JSON.stringify(FIX_CODES)}, "note": optional, at most ${String(INSIGHT_FIX_NOTE_MAX_LENGTH)} characters},`,
    ' "evidenceRefs": the ids of the evidence items you used}',
    INSIGHT_CATEGORY_RULE,
    terminologyNote(lang),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function insightSystemBlocks(
  kind: InsightKind,
  language: string,
  operatorPrompt: string,
): AiSystemBlock[] {
  const surfacePrompt = operatorPrompt !== '' ? operatorPrompt : defaultOpsPrompt(language);
  return [
    {
      text: [
        OPS_SECURITY_RULES,
        surfacePrompt,
        insightTask(kind),
        insightAnswerContract(language),
      ].join('\n\n'),
      cacheable: true,
    },
  ];
}

/** JSON schema of the answer, sent as the response schema when the model supports it. */
export const INSIGHT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'confidence', 'summary', 'fixes', 'evidenceRefs'],
  properties: {
    category: { type: 'string', enum: [...ROOT_CAUSE_CATEGORIES] },
    confidence: { type: 'string', enum: [...INSIGHT_CONFIDENCES] },
    summary: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'note'],
        properties: {
          code: { type: 'string', enum: [...FIX_CODES] },
          note: { type: 'string' },
        },
      },
    },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * The repair request after an unusable answer. It names the problem
 * (`insightAnswerProblem`: field, issue and length, never answer text), so the
 * retry fixes that instead of guessing.
 */
export function insightRepairRequest(problem: string): string {
  return `Your answer was not a valid JSON object of the required shape: ${problem}. Answer again with only the JSON object.`;
}

/** The translation prompt: the canonical summary into one language, nothing else. */
export function translationSystemBlocks(language: string): AiSystemBlock[] {
  const lang = promptLanguage(language);
  return [
    {
      text: [
        OPS_SECURITY_RULES,
        `Translate the text inside the untrusted block into ${LANGUAGE_NAMES[lang]}. Keep station ids, codes and numbers unchanged. Output only the translation, with nothing left out or added.`,
        terminologyNote(lang),
      ]
        .filter((line) => line !== '')
        .join('\n\n'),
      cacheable: true,
    },
  ];
}

/** Reads a JSON object from a model answer (plain JSON, or JSON in a code fence). */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  // An unreadable answer is retried once, then the rule insight is used.
  return tryParseJson(body.slice(start, end + 1)) ?? null;
}
