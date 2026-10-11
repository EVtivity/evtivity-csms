// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Driver AI support prompts (plan v0.1.45, section 2.6). The system prompt is
 * one static, cacheable block per language: the security rules, the surface
 * prompt (the built-in driver prompt, or the operator's
 * `driverAi.systemPrompt`, P1), the driver rules no operator prompt can
 * remove, the answer contract and the terminology note. The evidence goes
 * into the user message, driver-written and provider text framed untrusted.
 */

import type { AiSystemBlock } from '@evtivity/ai/core';
import { LANGUAGE_NAMES, promptLanguage, terminologyNote } from '@evtivity/ai/prompt';
import type { PromptLanguage } from '@evtivity/ai/prompt';
import {
  DRIVER_ACTION_CODES,
  DRIVER_AI_ANSWER_MAX_LENGTH,
  SUPPORT_CASE_CATEGORIES,
} from '@evtivity/lib/driver-ai';
import { OPS_SECURITY_RULES } from '@evtivity/services/ai-ops-prompt';
import { DRIVER_AI_RULES, defaultDriverAiPrompt } from '@evtivity/services/driver-ai-prompt';

/** The JSON answer contract with the closed category and action lists. */
export function driverAiAnswerContract(language: PromptLanguage): string {
  return [
    'Answer with one JSON object and nothing else:',
    `{"answer": plain text in ${LANGUAGE_NAMES[language]}, at most ${String(Math.floor((DRIVER_AI_ANSWER_MAX_LENGTH * 2) / 3))} characters, no links, no markdown,`,
    ` "category": one of ${JSON.stringify(SUPPORT_CASE_CATEGORIES)},`,
    ` "driverActions": a list of distinct codes from ${JSON.stringify(DRIVER_ACTION_CODES)} (may be empty),`,
    ' "needsOperator": true or false}',
  ].join('\n');
}

export function driverAiSystemBlocks(
  language: string | null | undefined,
  operatorPrompt: string,
): AiSystemBlock[] {
  const lang = promptLanguage(language);
  const surfacePrompt = operatorPrompt !== '' ? operatorPrompt : defaultDriverAiPrompt(lang);
  return [
    {
      text: [
        OPS_SECURITY_RULES,
        surfacePrompt,
        DRIVER_AI_RULES,
        driverAiAnswerContract(lang),
        terminologyNote(lang),
      ]
        .filter((part) => part !== '')
        .join('\n\n'),
      cacheable: true,
    },
  ];
}

/** JSON schema of the answer, sent as the response schema when the model supports it. */
export const DRIVER_AI_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'category', 'driverActions', 'needsOperator'],
  properties: {
    answer: { type: 'string' },
    category: { type: 'string', enum: [...SUPPORT_CASE_CATEGORIES] },
    driverActions: { type: 'array', items: { type: 'string', enum: [...DRIVER_ACTION_CODES] } },
    needsOperator: { type: 'boolean' },
  },
};

/** The repair request after an unusable answer: names the problem, never the answer text. */
export function driverAiRepairRequest(problem: string): string {
  return `Your answer was not accepted: ${problem}. Answer again with only the JSON object, following every rule.`;
}
