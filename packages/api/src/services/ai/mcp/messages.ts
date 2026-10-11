// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The URL elicitation message an MCP client shows its user when a write
 * becomes a proposal, in the user's CSMS language. Code on
 * purpose, like the assistant's built-in prompts: it is a fixed protocol
 * instruction, not operator content, and it names no proposal detail beyond
 * the tool and the station (the approval page in the CSMS shows the rest).
 */

const MESSAGES: Readonly<Record<string, (tool: string, station: string) => string>> = {
  en: (tool, station) =>
    `Approve or reject ${tool} for station ${station} in EVtivity CSMS (AI Inbox). Nothing runs until you approve it there.`,
  de: (tool, station) =>
    `Genehmigen Sie ${tool} für die Ladestation ${station} in EVtivity CSMS (KI-Posteingang) oder lehnen Sie es ab. Nichts wird ausgeführt, bevor Sie es dort genehmigen.`,
  es: (tool, station) =>
    `Apruebe o rechace ${tool} para la estación ${station} en EVtivity CSMS (bandeja de IA). Nada se ejecuta hasta que lo apruebe allí.`,
  ko: (tool, station) =>
    `EVtivity CSMS(AI 받은편지함)에서 충전소 ${station}의 ${tool}을(를) 승인하거나 거부하세요. 그곳에서 승인하기 전에는 아무것도 실행되지 않습니다.`,
  zh: (tool, station) =>
    `请在 EVtivity CSMS（AI 收件箱）中批准或拒绝充电站 ${station} 的 ${tool}。在那里批准之前，不会执行任何操作。`,
  'zh-TW': (tool, station) =>
    `請在 EVtivity CSMS（AI 收件匣）中核准或拒絕充電站 ${station} 的 ${tool}。在那裡核准之前，不會執行任何操作。`,
};

/** The approval message in `language`, English when the language has none. */
export function approvalMessage(language: string, tool: string, station: string): string {
  const build = MESSAGES[language] ?? MESSAGES['en'];
  return build === undefined ? '' : build(tool, station);
}

export const APPROVE_IN = 'EVtivity CSMS > AI Inbox';
