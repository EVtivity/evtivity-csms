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
 *
 * v0.1.44 (plan 2026-10-10): the `opsAi.*` surface for system-initiated runs,
 * the insight (`aiInsights.*`), worker (`aiWorkers.*`), MCP (`ai.mcp.*`) and
 * monthly and site budget (`ai.budget.*`) settings. The key names come from
 * the contracts in `ai-insights.ts`, `ai-proposals.ts` and `ai-usage.ts`; the
 * defaults live here (`AI_SETTING_DEFAULTS`), in the seed and in migration
 * 0441.
 *
 * v0.1.45 (plan 2026-10-11): the `driverAi.*` surface of driver support
 * analyses (off by default, decision E7), its per-driver limits
 * (`ai.budget.driverDailyTokens`, `ai.rateLimit.driverPerMinute`) and the
 * reservation insight switch (`aiInsights.reservation.enabled`). Key names
 * come from `driver-ai.ts` and `ai-insights.ts`; defaults are here, in the
 * seed and in migration 0469.
 */

import { AI_INSIGHT_SETTING_KEYS, OPS_AI_SETTING_KEYS } from './ai-insights.js';
import { AI_MCP_SETTING_KEYS, AI_WORKER_SETTING_KEYS } from './ai-proposals.js';
import { AI_BUDGET_SETTING_KEYS } from './ai-usage.js';
import { DRIVER_AI_SETTING_KEYS } from './driver-ai.js';
import { isUiLanguage } from './languages.js';
import type { UiLanguage } from './languages.js';

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const DEFAULT_AI_EFFORT: AiEffort = 'medium';
/** System-initiated runs default to the cheapest effort. */
export const DEFAULT_OPS_AI_EFFORT: AiEffort = 'low';
/** Driver support analyses default to the cheapest effort (decision E7). */
export const DEFAULT_DRIVER_AI_EFFORT: AiEffort = 'low';

export const AI_SUPPORT_TONES = ['professional', 'friendly', 'formal'] as const;
export type AiSupportTone = (typeof AI_SUPPORT_TONES)[number];
export const DEFAULT_AI_SUPPORT_TONE: AiSupportTone = 'professional';

/**
 * Settings prefix of each AI surface. `ops`: insights and background workers.
 * `driver`: driver support analyses (portal and mobile app).
 */
export const AI_SURFACE_PREFIXES = {
  chatbot: 'chatbotAi',
  support: 'supportAi',
  ops: 'opsAi',
  driver: 'driverAi',
} as const;
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

/**
 * Whole-number limits, shown in the Limits panel of Settings > AI. A budget
 * of 0 means no limit.
 */
export const AI_LIMIT_SETTINGS = {
  'ai.rateLimit.userPerMinute': { defaultValue: 10, min: 1, max: 1000 },
  'ai.rateLimit.sitePerMinute': { defaultValue: 60, min: 1, max: 100_000 },
  'ai.budget.userDailyTokens': { defaultValue: 2_000_000, min: 0, max: 10_000_000_000 },
  'ai.maxToolCallsPerTurn': { defaultValue: 20, min: 1, max: 100 },
  'ai.conversationRetentionDays': { defaultValue: 30, min: 1, max: 3650 },
  'ai.attachments.maxBytes': { defaultValue: 10_485_760, min: 1, max: 33_554_432 },
  'ai.attachments.maxPerMessage': { defaultValue: 5, min: 1, max: 20 },
  // Budgets in tokens; 0 means no limit.
  [AI_BUDGET_SETTING_KEYS.companyMonthlyTokens]: {
    defaultValue: 0,
    min: 0,
    max: 1_000_000_000_000,
  },
  [AI_BUDGET_SETTING_KEYS.siteMonthlyTokens]: { defaultValue: 0, min: 0, max: 1_000_000_000_000 },
  [AI_BUDGET_SETTING_KEYS.siteDailyTokens]: {
    defaultValue: 300_000,
    min: 0,
    max: 10_000_000_000,
  },
  [AI_BUDGET_SETTING_KEYS.warnPercent]: { defaultValue: 80, min: 1, max: 100 },
} as const satisfies Record<string, AiLimitDefinition>;
export type AiLimitSettingKey = keyof typeof AI_LIMIT_SETTINGS;

export function isAiLimitSettingKey(key: string): key is AiLimitSettingKey {
  return Object.hasOwn(AI_LIMIT_SETTINGS, key);
}

/** Whole-number thresholds of insights, background workers and the MCP server. */
export const AI_THRESHOLD_SETTINGS = {
  // Insights.
  [AI_INSIGHT_SETTING_KEYS.debounceSeconds]: { defaultValue: 120, min: 0, max: 3600 },
  [AI_INSIGHT_SETTING_KEYS.cooldownMinutes]: { defaultValue: 60, min: 1, max: 10_080 },
  [AI_INSIGHT_SETTING_KEYS.siteIncidentThreshold]: { defaultValue: 3, min: 2, max: 1000 },
  [AI_INSIGHT_SETTING_KEYS.maxPerSitePerDay]: { defaultValue: 50, min: 1, max: 10_000 },
  [AI_INSIGHT_SETTING_KEYS.retentionDays]: { defaultValue: 90, min: 1, max: 3650 },
  // Background workers.
  [AI_WORKER_SETTING_KEYS.stuckSessionsIdleMinutes]: { defaultValue: 90, min: 15, max: 1440 },
  [AI_WORKER_SETTING_KEYS.proposalTtlHours]: { defaultValue: 24, min: 1, max: 168 },
  // MCP server.
  [AI_MCP_SETTING_KEYS.rateLimitPerMinute]: { defaultValue: 60, min: 1, max: 10_000 },
  [AI_MCP_SETTING_KEYS.dailyCallsPerKey]: { defaultValue: 5000, min: 1, max: 10_000_000 },
} as const satisfies Record<string, AiLimitDefinition>;
export type AiThresholdSettingKey = keyof typeof AI_THRESHOLD_SETTINGS;

/**
 * Whole-number limits of driver support (decision E7), shown on the Driver
 * support tab of Settings > AI. The token budget of 0 means no limit.
 */
export const AI_DRIVER_NUMBER_SETTINGS = {
  [DRIVER_AI_SETTING_KEYS.maxCasesPerDriverPerDay]: { defaultValue: 3, min: 1, max: 100 },
  [DRIVER_AI_SETTING_KEYS.feedbackTimeoutHours]: { defaultValue: 24, min: 1, max: 168 },
  [DRIVER_AI_SETTING_KEYS.driverDailyTokens]: {
    defaultValue: 40_000,
    min: 0,
    max: 10_000_000_000,
  },
  [DRIVER_AI_SETTING_KEYS.driverPerMinute]: { defaultValue: 2, min: 1, max: 1000 },
} as const satisfies Record<string, AiLimitDefinition>;
export type AiDriverNumberSettingKey = keyof typeof AI_DRIVER_NUMBER_SETTINGS;

/** Every whole-number AI setting: the limits, the thresholds and the driver limits. */
export const AI_NUMBER_SETTINGS: Readonly<
  Record<AiLimitSettingKey | AiThresholdSettingKey | AiDriverNumberSettingKey, AiLimitDefinition>
> = { ...AI_LIMIT_SETTINGS, ...AI_THRESHOLD_SETTINGS, ...AI_DRIVER_NUMBER_SETTINGS };
export type AiNumberSettingKey =
  | AiLimitSettingKey
  | AiThresholdSettingKey
  | AiDriverNumberSettingKey;

export function isAiNumberSettingKey(key: string): key is AiNumberSettingKey {
  return Object.hasOwn(AI_NUMBER_SETTINGS, key);
}

/** A whole number in the setting's range (numeric strings accepted), else null. */
export function parseAiLimitValue(key: AiNumberSettingKey, value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  const { min, max } = AI_NUMBER_SETTINGS[key];
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * On and off switches with their defaults (decision D4): system-initiated AI,
 * MCP and MCP writes are off until an operator turns them on; the insight triggers are on
 * once `opsAi.enabled` is; every background worker job is off. Driver support
 * is off until an operator turns it on (decision E7).
 */
export const AI_FLAG_SETTINGS = {
  [OPS_AI_SETTING_KEYS.enabled]: false,
  [DRIVER_AI_SETTING_KEYS.enabled]: false,
  [AI_INSIGHT_SETTING_KEYS.stationEnabled]: true,
  [AI_INSIGHT_SETTING_KEYS.sessionEnabled]: true,
  [AI_INSIGHT_SETTING_KEYS.authorizationEnabled]: true,
  [AI_INSIGHT_SETTING_KEYS.reservationEnabled]: true,
  [AI_WORKER_SETTING_KEYS.networkSummaryEnabled]: false,
  [AI_WORKER_SETTING_KEYS.stuckSessionsEnabled]: false,
  [AI_WORKER_SETTING_KEYS.stuckSessionsUseModel]: false,
  [AI_WORKER_SETTING_KEYS.tariffAnomaliesEnabled]: false,
  [AI_MCP_SETTING_KEYS.enabled]: false,
  [AI_MCP_SETTING_KEYS.allowWrites]: false,
} as const satisfies Record<string, boolean>;
export type AiFlagSettingKey = keyof typeof AI_FLAG_SETTINGS;

export function isAiFlagSettingKey(key: string): key is AiFlagSettingKey {
  return Object.hasOwn(AI_FLAG_SETTINGS, key);
}

/** Most origins `ai.mcp.allowedOrigins` holds. */
export const AI_MCP_MAX_ALLOWED_ORIGINS = 50;

/**
 * An `ai.mcp.allowedOrigins` value: a list of http(s) origins
 * (`scheme://host[:port]`, no path, query or credentials), deduplicated and
 * in the URL's normalized form. Returns null when the value is not such a list.
 */
export function parseAiMcpAllowedOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > AI_MCP_MAX_ALLOWED_ORIGINS) return null;
  const origins: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = item.trim().replace(/\/$/, '');
    const url = URL.parse(text);
    if (url == null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      text.includes('?') ||
      text.includes('#')
    ) {
      return null;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * The default of every AI setting with a fixed default: the limits, the
 * switches, the `opsAi` and `driverAi` surfaces, the insight language and the
 * MCP origins.
 * The seed (`defaultSettings`, `seed.config.default.json`) and the seed
 * migrations hold the same values; a test keeps them equal.
 */
export const AI_SETTING_DEFAULTS: Readonly<Record<string, unknown>> = {
  ...Object.fromEntries(
    Object.entries(AI_NUMBER_SETTINGS).map(([key, def]) => [key, def.defaultValue]),
  ),
  ...AI_FLAG_SETTINGS,
  [OPS_AI_SETTING_KEYS.provider]: 'anthropic',
  [OPS_AI_SETTING_KEYS.model]: '',
  [OPS_AI_SETTING_KEYS.effort]: DEFAULT_OPS_AI_EFFORT,
  [OPS_AI_SETTING_KEYS.systemPrompt]: '',
  [DRIVER_AI_SETTING_KEYS.provider]: 'anthropic',
  [DRIVER_AI_SETTING_KEYS.model]: '',
  [DRIVER_AI_SETTING_KEYS.effort]: DEFAULT_DRIVER_AI_EFFORT,
  [DRIVER_AI_SETTING_KEYS.systemPrompt]: '',
  [AI_INSIGHT_SETTING_KEYS.primaryLanguage]: 'en',
  [AI_MCP_SETTING_KEYS.allowedOrigins]: [],
};

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

/** Key prefixes of every setting the cached AI settings reader holds. */
export const AI_SETTING_KEY_PREFIXES = [
  'ai.',
  'chatbotAi.',
  'supportAi.',
  'opsAi.',
  'driverAi.',
  'aiInsights.',
  'aiWorkers.',
] as const;

/** True for every key the cached AI settings reader holds. */
export function isAiSettingKey(key: string): boolean {
  return AI_SETTING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
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
  if (isAiNumberSettingKey(key)) {
    const n = parseAiLimitValue(key, value);
    return n != null ? { value: n } : null;
  }
  if (
    key === 'chatbotAi.provider' ||
    key === 'supportAi.provider' ||
    key === OPS_AI_SETTING_KEYS.provider ||
    key === DRIVER_AI_SETTING_KEYS.provider
  ) {
    return value === '' || isAiProviderId(value) ? { value } : null;
  }
  if (
    key === 'chatbotAi.effort' ||
    key === 'supportAi.effort' ||
    key === OPS_AI_SETTING_KEYS.effort ||
    key === DRIVER_AI_SETTING_KEYS.effort
  ) {
    return isAiEffort(value) ? { value } : null;
  }
  if (key === 'supportAi.tone') return isAiSupportTone(value) ? { value } : null;
  if (key === 'chatbotAi.enabled' || key === 'supportAi.enabled' || isAiFlagSettingKey(key)) {
    return typeof value === 'boolean' ? { value } : null;
  }
  if (key === AI_INSIGHT_SETTING_KEYS.primaryLanguage) {
    return isUiLanguage(value) ? { value } : null;
  }
  if (key === AI_MCP_SETTING_KEYS.allowedOrigins) {
    const origins = parseAiMcpAllowedOrigins(value);
    return origins != null ? { value: origins } : null;
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

/** Driver support analyses (`driverAi.*`). The per-driver budgets are in `AiLimits`. */
export interface AiDriverSurfaceSettings extends AiSurfaceSettings {
  /** AI-analyzed cases per driver per system-timezone day; more go straight to operators. */
  maxCasesPerDriverPerDay: number;
  /** Hours an answer waits for the driver's feedback before the case escalates. */
  feedbackTimeoutHours: number;
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
  /** 0 means no limit. */
  companyMonthlyTokens: number;
  /** Default monthly budget of every site; 0 means no limit. */
  siteMonthlyTokens: number;
  /** System-initiated surfaces only; 0 means no limit. */
  siteDailyTokens: number;
  /** Driver support tokens per driver per day; 0 means no limit. */
  driverDailyTokens: number;
  /** Driver support cases per driver per minute (checked at create). */
  driverPerMinute: number;
  /** A usage notice is raised when a scope crosses this percent of its budget. */
  budgetWarnPercent: number;
  maxToolCallsPerTurn: number;
  conversationRetentionDays: number;
  attachmentsMaxBytes: number;
  attachmentsMaxPerMessage: number;
}

/** Automatic insights (`aiInsights.*`). They also need `opsAi.enabled`. */
export interface AiInsightSettings {
  stationEnabled: boolean;
  sessionEnabled: boolean;
  authorizationEnabled: boolean;
  /** Reservation insights (`aiInsights.reservation.enabled`). */
  reservationEnabled: boolean;
  debounceSeconds: number;
  cooldownMinutes: number;
  siteIncidentThreshold: number;
  maxPerSitePerDay: number;
  /** Language of the canonical summary. */
  primaryLanguage: UiLanguage;
  retentionDays: number;
}

/** Background AI workers (`aiWorkers.*`). Each job also needs `opsAi.enabled`. */
export interface AiWorkerSettings {
  networkSummaryEnabled: boolean;
  stuckSessionsEnabled: boolean;
  stuckSessionsIdleMinutes: number;
  stuckSessionsUseModel: boolean;
  tariffAnomaliesEnabled: boolean;
  proposalTtlHours: number;
}

/** The MCP server (`ai.mcp.*`). */
export interface AiMcpSettings {
  enabled: boolean;
  rateLimitPerMinute: number;
  dailyCallsPerKey: number;
  /**
   * MCP write tools are listed and run (`ai.mcp.allowWrites`), under the API
   * key's own permissions and site scope. Off: only reads.
   */
  allowWrites: boolean;
  /** Allowed `Origin` header values; empty allows none (a request without `Origin` passes). */
  allowedOrigins: string[];
}

export interface AiSettings {
  chatbot: AiSurfaceSettings;
  support: AiSupportSurfaceSettings;
  /** System-initiated runs: insights and background workers. */
  ops: AiSurfaceSettings;
  /** Driver support analyses. */
  driver: AiDriverSurfaceSettings;
  providers: Record<AiProviderId, AiProviderSettings>;
  limits: AiLimits;
  insights: AiInsightSettings;
  workers: AiWorkerSettings;
  mcp: AiMcpSettings;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function limit(values: Map<string, unknown>, key: AiNumberSettingKey): number {
  return parseAiLimitValue(key, values.get(key)) ?? AI_NUMBER_SETTINGS[key].defaultValue;
}

function flag(values: Map<string, unknown>, key: AiFlagSettingKey): boolean {
  const value = values.get(key);
  return typeof value === 'boolean' ? value : AI_FLAG_SETTINGS[key];
}

function surface(
  values: Map<string, unknown>,
  prefix: string,
  defaultEffort: AiEffort = DEFAULT_AI_EFFORT,
): AiSurfaceSettings {
  const provider = values.get(`${prefix}.provider`);
  const effort = values.get(`${prefix}.effort`);
  return {
    enabled: values.get(`${prefix}.enabled`) === true,
    provider: isAiProviderId(provider) ? provider : null,
    model: str(values.get(`${prefix}.model`)).trim(),
    effort: isAiEffort(effort) ? effort : defaultEffort,
    systemPrompt: str(values.get(`${prefix}.systemPrompt`)),
  };
}

/** Builds the settings from stored rows; missing or invalid values get their defaults. */
export function buildAiSettings(rows: { key: string; value: unknown }[]): AiSettings {
  const values = new Map(rows.map((r) => [r.key, r.value]));
  const tone = values.get('supportAi.tone');
  const language = values.get(AI_INSIGHT_SETTING_KEYS.primaryLanguage);
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
    ops: surface(values, AI_SURFACE_PREFIXES.ops, DEFAULT_OPS_AI_EFFORT),
    driver: {
      ...surface(values, AI_SURFACE_PREFIXES.driver, DEFAULT_DRIVER_AI_EFFORT),
      maxCasesPerDriverPerDay: limit(values, DRIVER_AI_SETTING_KEYS.maxCasesPerDriverPerDay),
      feedbackTimeoutHours: limit(values, DRIVER_AI_SETTING_KEYS.feedbackTimeoutHours),
    },
    providers,
    limits: {
      userPerMinute: limit(values, 'ai.rateLimit.userPerMinute'),
      sitePerMinute: limit(values, 'ai.rateLimit.sitePerMinute'),
      userDailyTokens: limit(values, 'ai.budget.userDailyTokens'),
      companyMonthlyTokens: limit(values, AI_BUDGET_SETTING_KEYS.companyMonthlyTokens),
      siteMonthlyTokens: limit(values, AI_BUDGET_SETTING_KEYS.siteMonthlyTokens),
      siteDailyTokens: limit(values, AI_BUDGET_SETTING_KEYS.siteDailyTokens),
      driverDailyTokens: limit(values, DRIVER_AI_SETTING_KEYS.driverDailyTokens),
      driverPerMinute: limit(values, DRIVER_AI_SETTING_KEYS.driverPerMinute),
      budgetWarnPercent: limit(values, AI_BUDGET_SETTING_KEYS.warnPercent),
      maxToolCallsPerTurn: limit(values, 'ai.maxToolCallsPerTurn'),
      conversationRetentionDays: limit(values, 'ai.conversationRetentionDays'),
      attachmentsMaxBytes: limit(values, 'ai.attachments.maxBytes'),
      attachmentsMaxPerMessage: limit(values, 'ai.attachments.maxPerMessage'),
    },
    insights: {
      stationEnabled: flag(values, AI_INSIGHT_SETTING_KEYS.stationEnabled),
      sessionEnabled: flag(values, AI_INSIGHT_SETTING_KEYS.sessionEnabled),
      authorizationEnabled: flag(values, AI_INSIGHT_SETTING_KEYS.authorizationEnabled),
      reservationEnabled: flag(values, AI_INSIGHT_SETTING_KEYS.reservationEnabled),
      debounceSeconds: limit(values, AI_INSIGHT_SETTING_KEYS.debounceSeconds),
      cooldownMinutes: limit(values, AI_INSIGHT_SETTING_KEYS.cooldownMinutes),
      siteIncidentThreshold: limit(values, AI_INSIGHT_SETTING_KEYS.siteIncidentThreshold),
      maxPerSitePerDay: limit(values, AI_INSIGHT_SETTING_KEYS.maxPerSitePerDay),
      primaryLanguage: isUiLanguage(language) ? language : 'en',
      retentionDays: limit(values, AI_INSIGHT_SETTING_KEYS.retentionDays),
    },
    workers: {
      networkSummaryEnabled: flag(values, AI_WORKER_SETTING_KEYS.networkSummaryEnabled),
      stuckSessionsEnabled: flag(values, AI_WORKER_SETTING_KEYS.stuckSessionsEnabled),
      stuckSessionsIdleMinutes: limit(values, AI_WORKER_SETTING_KEYS.stuckSessionsIdleMinutes),
      stuckSessionsUseModel: flag(values, AI_WORKER_SETTING_KEYS.stuckSessionsUseModel),
      tariffAnomaliesEnabled: flag(values, AI_WORKER_SETTING_KEYS.tariffAnomaliesEnabled),
      proposalTtlHours: limit(values, AI_WORKER_SETTING_KEYS.proposalTtlHours),
    },
    mcp: {
      enabled: flag(values, AI_MCP_SETTING_KEYS.enabled),
      rateLimitPerMinute: limit(values, AI_MCP_SETTING_KEYS.rateLimitPerMinute),
      dailyCallsPerKey: limit(values, AI_MCP_SETTING_KEYS.dailyCallsPerKey),
      allowWrites: flag(values, AI_MCP_SETTING_KEYS.allowWrites),
      allowedOrigins:
        parseAiMcpAllowedOrigins(values.get(AI_MCP_SETTING_KEYS.allowedOrigins)) ?? [],
    },
  };
}
