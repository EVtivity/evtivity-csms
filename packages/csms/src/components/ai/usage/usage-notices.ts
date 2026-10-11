// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';

// Kept apart from usage-api.ts: the event stream in the Layout imports this,
// so it must stay small (no pricing or chart code in the startup chunk).

/**
 * A threshold notice from the SSE event `ai.usage.threshold`.
 */
export interface AiUsageNotice {
  scope: 'company' | 'site';
  siteId: string | null;
  level: 'warn' | 'exceeded';
  percent: number;
  period: string;
}

/** Reads an `ai.usage.threshold` event, or null for any other shape. */
export function parseAiUsageThreshold(event: unknown): AiUsageNotice | null {
  if (event == null || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;
  if (e['eventType'] !== 'ai.usage.threshold') return null;
  const scope = e['scope'];
  const level = e['level'];
  const percent = e['percent'];
  if (scope !== 'company' && scope !== 'site') return null;
  if (level !== 'warn' && level !== 'exceeded') return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const siteId = typeof e['siteId'] === 'string' ? e['siteId'] : null;
  if (scope === 'site' && siteId == null) return null;
  return {
    scope,
    siteId,
    level,
    percent,
    period: typeof e['period'] === 'string' ? e['period'] : '',
  };
}

function noticeKey(n: AiUsageNotice): string {
  return `${n.scope}:${n.siteId ?? ''}`;
}

interface AiUsageNoticeState {
  notices: AiUsageNotice[];
  record: (event: unknown) => void;
  dismiss: (notice: AiUsageNotice) => void;
}

/**
 * Threshold notices received in this browser session, newest per scope. The
 * banners in the AI panel read them; a dismissed one stays hidden until the
 * next notice for its scope.
 */
export const useAiUsageNotices = create<AiUsageNoticeState>((set) => ({
  notices: [],
  record: (event) => {
    const notice = parseAiUsageThreshold(event);
    if (notice == null) return;
    set((s) => ({
      notices: [notice, ...s.notices.filter((n) => noticeKey(n) !== noticeKey(notice))],
    }));
  },
  dismiss: (notice) => {
    set((s) => ({ notices: s.notices.filter((n) => noticeKey(n) !== noticeKey(notice)) }));
  },
}));
