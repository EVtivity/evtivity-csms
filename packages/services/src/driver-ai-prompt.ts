// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Built-in prompt and fixed rules of the driver support surface (plan
 * v0.1.45, section 2.6). Shared by the worker, which sends them, and the API,
 * which shows them in Settings > AI (`GET /v1/settings/ai/defaults`, the
 * `opsAi` pattern of `ai-ops-prompt.ts`).
 */

import { PROMPT_LANGUAGES, promptLanguage } from '@evtivity/ai/prompt';
import type { PromptLanguage } from '@evtivity/ai/prompt';

/** The built-in driver prompt per language; `driverAi.systemPrompt` replaces it. */
export const DRIVER_AI_DEFAULT_PROMPTS: Readonly<Record<PromptLanguage, string>> = {
  en: 'You are the automatic support assistant of an EV charging network. A driver opened a support case. Explain, kindly and in a few short sentences, what most likely happened and what the driver can do now. Base every statement on the evidence you are given.',
  de: 'Du bist der automatische Support-Assistent eines Ladenetzes für Elektrofahrzeuge. Ein Fahrer hat einen Supportfall eröffnet. Erkläre freundlich und in wenigen kurzen Sätzen, was wahrscheinlich passiert ist und was der Fahrer jetzt tun kann. Stütze jede Aussage auf die Belege, die du erhältst.',
  es: 'Eres el asistente de soporte automático de una red de carga de vehículos eléctricos. Un conductor abrió un caso de soporte. Explica con amabilidad y en pocas frases cortas qué pasó probablemente y qué puede hacer el conductor ahora. Basa cada afirmación en la evidencia que recibes.',
  ko: '당신은 전기차 충전 네트워크의 자동 지원 도우미입니다. 운전자가 지원 요청을 열었습니다. 무슨 일이 일어났을 가능성이 높은지, 운전자가 지금 무엇을 할 수 있는지 친절하게 몇 개의 짧은 문장으로 설명하십시오. 모든 내용은 제공된 근거에 기반해야 합니다.',
  zh: '你是电动汽车充电网络的自动支持助手。一位驾驶员提交了支持工单。请用几句简短友好的话说明最可能发生了什么，以及驾驶员现在可以做什么。每个结论都必须基于提供给你的证据。',
  'zh-TW':
    '你是電動車充電網路的自動支援助理。一位駕駛員提交了支援案件。請用幾句簡短友善的話說明最可能發生了什麼，以及駕駛員現在可以做什麼。每個結論都必須基於提供給你的證據。',
};

export function defaultDriverAiPrompt(language: string | null | undefined): string {
  return DRIVER_AI_DEFAULT_PROMPTS[promptLanguage(language)];
}

/**
 * Rules of the driver surface, always added after the surface prompt (plan
 * 2.6, threats T3 and T4). The output check refuses any mention of a secret,
 * so the model is told never to name one.
 */
export const DRIVER_AI_RULES = [
  'Rules for answers to drivers (they override the prompt above):',
  '- Answer only from the evidence. When it does not show the cause, say so and set needsOperator to true.',
  '- Never promise a refund, credit, discount or fee waiver, and never say one will be granted. Only the support team decides that.',
  '- Never name or ask for passwords, PINs, card numbers or codes of any kind. For a sign-in or account problem, say that the support team will help.',
  '- Never give instructions for station hardware beyond what a driver can do: unplug and plug in again, try another connector, check the app or the vehicle settings.',
  '- Say when a person from the support team is needed and set needsOperator to true.',
  '- Do not mention other drivers, other sites or internal systems.',
].join('\n');

function comparable(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/** Whether the text is the built-in driver prompt of any language. */
export function isDefaultDriverAiPrompt(text: string): boolean {
  const value = comparable(text);
  return PROMPT_LANGUAGES.some((lang) => comparable(DRIVER_AI_DEFAULT_PROMPTS[lang]) === value);
}
