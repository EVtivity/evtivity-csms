// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `opsAi` surface: runs nobody starts (automatic
 * insights, background workers) have no caller, so there is no personal
 * configuration. The provider key is the company key `ai.<provider>.apiKeyEnc`;
 * an empty model is the provider's router model (the cheapest class). The one
 * resolver of the surface, shared by the insight generator and the background
 * workers.
 */

import { decryptString, validateAiBaseUrl } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import { getProviderEntry } from '@evtivity/ai/core';
import type { AiAdapter, Effort, ProviderId } from '@evtivity/ai/core';
import { getProviderRegistry } from '@evtivity/ai/providers';
import { trackAiProviderCalls } from './ai-alerts.js';

export interface OpsAiConfig {
  provider: ProviderId;
  apiKey: string;
  /** Empty: the provider's official endpoint. */
  baseUrl: string;
  model: string;
  effort: Effort;
  /** The operator's prompt, empty for the built-in one. */
  systemPrompt: string;
}

/**
 * Resolves the surface, or null when it cannot run: no provider chosen, no
 * key for the provider, or a stored base URL that fails the check (a row
 * written another way must not send the key to a private or plain-http
 * host). It does not look at `opsAi.enabled`: callers check their switches.
 * Throws when the stored key cannot be decrypted.
 */
export function resolveOpsAiConfig(
  settings: AiSettings,
  encryptionKey: string,
  allowPrivateHosts: boolean,
): OpsAiConfig | null {
  const { provider } = settings.ops;
  if (provider === null) return null;
  const credentials = settings.providers[provider];
  if (credentials.apiKeyEnc === '') return null;
  const baseUrl = validateAiBaseUrl(credentials.baseUrl, { allowPrivateHosts });
  if (baseUrl === null) return null;
  const model =
    settings.ops.model !== '' ? settings.ops.model : getProviderEntry(provider).routerModel;
  return {
    provider,
    apiKey: decryptString(credentials.apiKeyEnc, encryptionKey),
    baseUrl,
    model,
    effort: settings.ops.effort,
    systemPrompt: settings.ops.systemPrompt.trim(),
  };
}

/** The company key's adapter; its calls keep the provider quota alert state. */
export function createOpsAdapter(config: OpsAiConfig): AiAdapter {
  return trackAiProviderCalls(
    getProviderRegistry().create(config.provider, {
      apiKey: config.apiKey,
      ...(config.baseUrl !== '' ? { baseUrl: config.baseUrl } : {}),
    }),
  );
}
