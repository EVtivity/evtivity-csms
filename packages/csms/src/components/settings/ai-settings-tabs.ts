// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > AI tabs in order; `?tab=ai&sub=<id>` opens one (plan v0.1.45,
 * section 6). The `usage` id predates the split, so old `sub=usage` links still
 * open usage. The background workers moved into Automatic insights (v0.1.45),
 * so an old `sub=workers` link opens that tab. Labels: `settings.aiTabs.<id>`,
 * descriptions: `settings.aiTabs.<id>Description`.
 */
export const AI_SETTINGS_TABS = [
  'providers',
  'assistant',
  'support',
  'driver',
  'insights',
  'mcp',
  'usage',
] as const;

export type AiSettingsTab = (typeof AI_SETTINGS_TABS)[number];

export const DEFAULT_AI_SETTINGS_TAB: AiSettingsTab = 'providers';

/** An unknown id (such as the old `config`) falls back to the default tab. */
export function resolveAiSettingsTab(value: string): AiSettingsTab {
  if (value === 'workers') return 'insights';
  return (AI_SETTINGS_TABS as readonly string[]).includes(value)
    ? (value as AiSettingsTab)
    : DEFAULT_AI_SETTINGS_TAB;
}
