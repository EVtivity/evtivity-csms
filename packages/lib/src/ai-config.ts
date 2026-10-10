// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI assistant and support AI settings (plan 2026-10-09, section 3.4).
 * Browser-safe: the CSMS settings page reads the same names and limits.
 *
 * - One credential set per provider: `ai.<provider>.apiKeyEnc` and
 *   `ai.<provider>.baseUrl` (empty means the official endpoint). Each surface
 *   (`chatbotAi.*`, `supportAi.*`) picks a provider, model and effort.
 * - Limits live under `ai.*` with the defaults below.
 * - The cached reader is `getAiSettings()` in `@evtivity/database`.
 *
 * The provider and effort lists mirror `PROVIDER_IDS` and `EFFORTS` in the
 * API's `services/ai/core/types.ts`; a test keeps them equal.
 */

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const DEFAULT_AI_EFFORT: AiEffort = 'medium';

export const AI_SUPPORT_TONES = ['professional', 'friendly', 'formal'] as const;
export type AiSupportTone = (typeof AI_SUPPORT_TONES)[number];
export const DEFAULT_AI_SUPPORT_TONE: AiSupportTone = 'professional';

/** Settings prefix of each AI surface. */
export const AI_SURFACE_PREFIXES = { chatbot: 'chatbotAi', support: 'supportAi' } as const;
export type AiSurface = keyof typeof AI_SURFACE_PREFIXES;

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isAiEffort(value: unknown): value is AiEffort {
  return typeof value === 'string' && (AI_EFFORTS as readonly string[]).includes(value);
}

export function isAiSupportTone(value: unknown): value is AiSupportTone {
  return typeof value === 'string' && (AI_SUPPORT_TONES as readonly string[]).includes(value);
}

/** `ai.<provider>.apiKeyEnc`: the provider's API key, encrypted at rest. */
export function aiProviderApiKeySettingKey(provider: AiProviderId): string {
  return `ai.${provider}.apiKeyEnc`;
}

/** `ai.<provider>.baseUrl`: an https endpoint override, empty for the official one. */
export function aiProviderBaseUrlSettingKey(provider: AiProviderId): string {
  return `ai.${provider}.baseUrl`;
}

/** True for `ai.<provider>.baseUrl` of a known provider. */
export function isAiBaseUrlSettingKey(key: string): boolean {
  return AI_PROVIDER_IDS.some((p) => key === aiProviderBaseUrlSettingKey(p));
}

interface AiLimitDefinition {
  defaultValue: number;
  min: number;
  max: number;
}

/** Whole-number limits. `ai.budget.userDailyTokens` 0 means no daily budget. */
export const AI_LIMIT_SETTINGS = {
  'ai.rateLimit.userPerMinute': { defaultValue: 10, min: 1, max: 1000 },
  'ai.rateLimit.sitePerMinute': { defaultValue: 60, min: 1, max: 100_000 },
  'ai.budget.userDailyTokens': { defaultValue: 2_000_000, min: 0, max: 10_000_000_000 },
  'ai.maxToolCallsPerTurn': { defaultValue: 20, min: 1, max: 100 },
  'ai.conversationRetentionDays': { defaultValue: 30, min: 1, max: 3650 },
  'ai.attachments.maxBytes': { defaultValue: 10_485_760, min: 1, max: 33_554_432 },
  'ai.attachments.maxPerMessage': { defaultValue: 5, min: 1, max: 20 },
} as const satisfies Record<string, AiLimitDefinition>;
export type AiLimitSettingKey = keyof typeof AI_LIMIT_SETTINGS;

export function isAiLimitSettingKey(key: string): key is AiLimitSettingKey {
  return Object.hasOwn(AI_LIMIT_SETTINGS, key);
}

/** A whole number in the limit's range (numeric strings accepted), else null. */
export function parseAiLimitValue(key: AiLimitSettingKey, value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  const { min, max } = AI_LIMIT_SETTINGS[key];
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Settings removed by the AI upgrade (P13): sampling replaced by effort, and
 * one key per provider replacing the per-surface keys. Migration 0371 moves
 * the keys and deletes these rows; writes of them are refused.
 */
export const REMOVED_AI_SETTING_KEYS: Readonly<Record<string, string>> = {
  'chatbotAi.apiKeyEnc': 'ai.<provider>.apiKeyEnc',
  'chatbotAi.temperature': 'chatbotAi.effort',
  'chatbotAi.topP': 'chatbotAi.effort',
  'chatbotAi.topK': 'chatbotAi.effort',
  'supportAi.apiKeyEnc': 'ai.<provider>.apiKeyEnc',
  'supportAi.temperature': 'supportAi.effort',
  'supportAi.topP': 'supportAi.effort',
  'supportAi.topK': 'supportAi.effort',
};

/** True for every key the cached AI settings reader holds. */
export function isAiSettingKey(key: string): boolean {
  return key.startsWith('ai.') || key.startsWith('chatbotAi.') || key.startsWith('supportAi.');
}

/**
 * Validates an AI surface or limit setting value (not the base URL, which
 * needs a host check: `validateAiBaseUrl`). Returns the value to store, null
 * when invalid, or undefined when the key has no constraint here.
 */
export function normalizeAiSettingValue(
  key: string,
  value: unknown,
): { value: unknown } | null | undefined {
  if (Object.hasOwn(REMOVED_AI_SETTING_KEYS, key)) return null;
  if (isAiLimitSettingKey(key)) {
    const n = parseAiLimitValue(key, value);
    return n != null ? { value: n } : null;
  }
  if (key === 'chatbotAi.provider' || key === 'supportAi.provider') {
    return value === '' || isAiProviderId(value) ? { value } : null;
  }
  if (key === 'chatbotAi.effort' || key === 'supportAi.effort') {
    return isAiEffort(value) ? { value } : null;
  }
  if (key === 'supportAi.tone') return isAiSupportTone(value) ? { value } : null;
  if (key === 'chatbotAi.enabled' || key === 'supportAi.enabled') {
    return typeof value === 'boolean' ? { value } : null;
  }
  return undefined;
}

/** One AI surface (`chatbotAi.*` or `supportAi.*`). */
export interface AiSurfaceSettings {
  enabled: boolean;
  /** Null when unset or not a known provider: the surface is not configured. */
  provider: AiProviderId | null;
  /** Empty: the provider's default model. */
  model: string;
  effort: AiEffort;
  /** Empty: the built-in prompt. */
  systemPrompt: string;
}

export interface AiSupportSurfaceSettings extends AiSurfaceSettings {
  tone: AiSupportTone;
}

/** One provider's credentials. The key stays encrypted: callers decrypt it. */
export interface AiProviderSettings {
  /** `ai.<provider>.apiKeyEnc` ciphertext, empty when unset. */
  apiKeyEnc: string;
  /** Empty: the official endpoint. */
  baseUrl: string;
}

export interface AiLimits {
  userPerMinute: number;
  sitePerMinute: number;
  /** 0 means no daily budget. */
  userDailyTokens: number;
  maxToolCallsPerTurn: number;
  conversationRetentionDays: number;
  attachmentsMaxBytes: number;
  attachmentsMaxPerMessage: number;
}

export interface AiSettings {
  chatbot: AiSurfaceSettings;
  support: AiSupportSurfaceSettings;
  providers: Record<AiProviderId, AiProviderSettings>;
  limits: AiLimits;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function limit(values: Map<string, unknown>, key: AiLimitSettingKey): number {
  return parseAiLimitValue(key, values.get(key)) ?? AI_LIMIT_SETTINGS[key].defaultValue;
}

function surface(values: Map<string, unknown>, prefix: string): AiSurfaceSettings {
  const provider = values.get(`${prefix}.provider`);
  const effort = values.get(`${prefix}.effort`);
  return {
    enabled: values.get(`${prefix}.enabled`) === true,
    provider: isAiProviderId(provider) ? provider : null,
    model: str(values.get(`${prefix}.model`)).trim(),
    effort: isAiEffort(effort) ? effort : DEFAULT_AI_EFFORT,
    systemPrompt: str(values.get(`${prefix}.systemPrompt`)),
  };
}

/** Builds the settings from stored rows; missing or invalid values get their defaults. */
export function buildAiSettings(rows: { key: string; value: unknown }[]): AiSettings {
  const values = new Map(rows.map((r) => [r.key, r.value]));
  const tone = values.get('supportAi.tone');
  const providers = Object.fromEntries(
    AI_PROVIDER_IDS.map((p) => [
      p,
      {
        apiKeyEnc: str(values.get(aiProviderApiKeySettingKey(p))),
        baseUrl: str(values.get(aiProviderBaseUrlSettingKey(p))).trim(),
      },
    ]),
  ) as Record<AiProviderId, AiProviderSettings>;
  return {
    chatbot: surface(values, 'chatbotAi'),
    support: {
      ...surface(values, 'supportAi'),
      tone: isAiSupportTone(tone) ? tone : DEFAULT_AI_SUPPORT_TONE,
    },
    providers,
    limits: {
      userPerMinute: limit(values, 'ai.rateLimit.userPerMinute'),
      sitePerMinute: limit(values, 'ai.rateLimit.sitePerMinute'),
      userDailyTokens: limit(values, 'ai.budget.userDailyTokens'),
      maxToolCallsPerTurn: limit(values, 'ai.maxToolCallsPerTurn'),
      conversationRetentionDays: limit(values, 'ai.conversationRetentionDays'),
      attachmentsMaxBytes: limit(values, 'ai.attachments.maxBytes'),
      attachmentsMaxPerMessage: limit(values, 'ai.attachments.maxPerMessage'),
    },
  };
}
