// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Surface configuration: which provider, key, model, effort and prompt a
 * user's turn runs with. A user's own configuration (Profile, the
 * `chatbot_ai_configs` row) comes first, then the surface settings with the
 * provider key `ai.<provider>.apiKeyEnc` (cached reader `getAiSettings`).
 */

import { eq } from 'drizzle-orm';
import { db, chatbotAiConfigs, getAiSettings } from '@evtivity/database';
import { decryptString, validateAiBaseUrl } from '@evtivity/lib';
import { DEFAULT_AI_SUPPORT_TONE, isAiEffort, isAiSupportTone } from '@evtivity/lib/ai-config';
import type { AiSettings, AiSupportTone } from '@evtivity/lib/ai-config';
import { config as apiConfig } from '../../../lib/config.js';
import { isProviderId } from '../core/types.js';
import type { Effort, ProviderId } from '../core/types.js';
import { resolveModelId } from '../core/model-registry.js';
import type { AiSurface } from '../tools/policy.js';

export type SupportTone = AiSupportTone;

export interface AiSurfaceConfig {
  surface: AiSurface;
  provider: ProviderId;
  apiKey: string;
  /** Empty: the provider's official endpoint. */
  baseUrl: string;
  model: string;
  effort: Effort;
  /** The operator's prompt; empty uses the built-in default. */
  systemPrompt: string;
  tone: SupportTone;
  source: 'user' | 'system';
}

/**
 * The surface cannot run: no usable provider and key (400 AI_NOT_CONFIGURED /
 * SUPPORT_AI_NOT_CONFIGURED), or a stored base URL that fails the check
 * (400 AI_BASE_URL_INVALID).
 */
export class AiNotConfiguredError extends Error {
  readonly code: 'AI_NOT_CONFIGURED' | 'SUPPORT_AI_NOT_CONFIGURED' | 'AI_BASE_URL_INVALID';
  constructor(surface: AiSurface, reason: 'not_configured' | 'base_url' = 'not_configured') {
    super(
      reason === 'base_url'
        ? 'The AI provider base URL is not allowed'
        : surface === 'support'
          ? 'Support AI is not configured'
          : 'AI is not configured',
    );
    this.name = 'AiNotConfiguredError';
    this.code =
      reason === 'base_url'
        ? 'AI_BASE_URL_INVALID'
        : surface === 'support'
          ? 'SUPPORT_AI_NOT_CONFIGURED'
          : 'AI_NOT_CONFIGURED';
  }
}

function decrypt(ciphertext: string): string {
  return decryptString(ciphertext, apiConfig.SETTINGS_ENCRYPTION_KEY);
}

/**
 * The settings write already refused a bad base URL; checking it again before
 * the key is sent keeps a row written another way (SQL, an old release) from
 * sending the key to a private or plain-http host.
 */
function checkedBaseUrl(surface: AiSurface, baseUrl: string): string {
  const valid = validateAiBaseUrl(baseUrl, {
    allowPrivateHosts: apiConfig.NODE_ENV === 'development',
  });
  if (valid === null) throw new AiNotConfiguredError(surface, 'base_url');
  return valid;
}

interface PersonalConfig {
  provider: string | null | undefined;
  apiKeyEnc: string | null | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  systemPrompt: string | null | undefined;
  tone: string | null | undefined;
}

export async function resolveSurfaceConfig(
  surface: AiSurface,
  userId: string,
): Promise<AiSurfaceConfig> {
  const [settings, [row]] = await Promise.all([
    getAiSettings(),
    db.select().from(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId)).limit(1),
  ]);
  const surfaceSettings: AiSettings['chatbot'] =
    surface === 'support' ? settings.support : settings.chatbot;
  const settingTone = surface === 'support' ? settings.support.tone : DEFAULT_AI_SUPPORT_TONE;

  // The row is shared by both surfaces; empty fields of one surface fall
  // through to the system settings.
  const personal: PersonalConfig =
    surface === 'chatbot'
      ? {
          provider: row?.provider,
          apiKeyEnc: row?.apiKeyEnc,
          model: row?.model,
          effort: row?.effort,
          systemPrompt: row?.systemPrompt,
          tone: null,
        }
      : {
          provider: row?.supportAiProvider,
          apiKeyEnc: row?.supportAiApiKeyEnc,
          model: row?.supportAiModel,
          effort: row?.supportAiEffort,
          systemPrompt: row?.supportAiSystemPrompt,
          tone: row?.supportAiTone,
        };
  // The company switch wins: a disabled surface does not run, personal
  // configuration or not.
  if (!surfaceSettings.enabled) throw new AiNotConfiguredError(surface);
  if (isProviderId(personal.provider) && personal.apiKeyEnc != null && personal.apiKeyEnc !== '') {
    return {
      surface,
      provider: personal.provider,
      apiKey: decrypt(personal.apiKeyEnc),
      baseUrl: checkedBaseUrl(surface, settings.providers[personal.provider].baseUrl),
      model: resolveModelId(personal.provider, personal.model),
      effort: isAiEffort(personal.effort) ? personal.effort : surfaceSettings.effort,
      systemPrompt: personal.systemPrompt?.trim() ?? '',
      tone: isAiSupportTone(personal.tone) ? personal.tone : settingTone,
      source: 'user',
    };
  }

  const provider = surfaceSettings.provider;
  if (provider === null) throw new AiNotConfiguredError(surface);
  const credentials = settings.providers[provider];
  if (credentials.apiKeyEnc === '') throw new AiNotConfiguredError(surface);
  return {
    surface,
    provider,
    apiKey: decrypt(credentials.apiKeyEnc),
    baseUrl: checkedBaseUrl(surface, credentials.baseUrl),
    model: resolveModelId(provider, surfaceSettings.model),
    effort: surfaceSettings.effort,
    systemPrompt: surfaceSettings.systemPrompt.trim(),
    tone: settingTone,
    source: 'system',
  };
}

/**
 * Whether the user can run a turn on the surface, checked without decrypting
 * a key. The surface must be enabled (the company switch wins over personal
 * configurations); then the user's own provider and key, or the surface
 * provider with its key set. Either way the provider needs an adapter in this
 * build (`hasAdapter`) and a base URL that passes the check.
 */
export async function isSurfaceAvailable(
  surface: AiSurface,
  userId: string,
  hasAdapter: (provider: ProviderId) => boolean,
): Promise<boolean> {
  const [settings, [row]] = await Promise.all([
    getAiSettings(),
    db.select().from(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId)).limit(1),
  ]);
  const usable = (provider: ProviderId): boolean =>
    hasAdapter(provider) &&
    validateAiBaseUrl(settings.providers[provider].baseUrl, {
      allowPrivateHosts: apiConfig.NODE_ENV === 'development',
    }) !== null;
  const surfaceSettings = surface === 'support' ? settings.support : settings.chatbot;
  if (!surfaceSettings.enabled) return false;
  const personalProvider = surface === 'support' ? row?.supportAiProvider : row?.provider;
  const personalKey = surface === 'support' ? row?.supportAiApiKeyEnc : row?.apiKeyEnc;
  if (isProviderId(personalProvider) && personalKey != null && personalKey !== '') {
    return usable(personalProvider);
  }
  const provider = surfaceSettings.provider;
  return provider !== null && settings.providers[provider].apiKeyEnc !== '' && usable(provider);
}
