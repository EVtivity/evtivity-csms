// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `driverAi` surface (plan v0.1.45, decision E11): driver support
 * analysis runs on its own switch, provider, model and prompt, so operators
 * can pick a cheaper model and turn it off on its own. The provider key is the
 * company key `ai.<provider>.apiKeyEnc`; an empty model is the provider's
 * router model (the cheapest class). The one resolver of the surface, used by
 * the portal features route (is it usable?) and the worker (the call).
 */

import { decryptString, validateAiBaseUrl } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import { getProviderEntry } from '@evtivity/ai/core';
import type { AiAdapter } from '@evtivity/ai/core';
import { getProviderRegistry } from '@evtivity/ai/providers';
import type { OpsAiConfig } from './ai-ops-config.js';

/** Same shape as the ops surface: provider, key, endpoint, model, effort, prompt. */
export type DriverAiConfig = OpsAiConfig;

/** Output budget of one driver answer (decision E7). */
export const DRIVER_AI_MAX_OUTPUT_TOKENS = 2048;

/**
 * True when the surface is on and has a provider with a key and an accepted
 * endpoint. Does not decrypt the key. The portal shows the AI choice only then.
 */
export function isDriverAiUsable(settings: AiSettings, allowPrivateHosts: boolean): boolean {
  const { enabled, provider } = settings.driver;
  if (!enabled || provider === null) return false;
  const credentials = settings.providers[provider];
  if (credentials.apiKeyEnc === '') return false;
  return validateAiBaseUrl(credentials.baseUrl, { allowPrivateHosts }) !== null;
}

/**
 * Resolves the surface, or null when it cannot run: no provider chosen, no
 * key for the provider, or a stored base URL that fails the check. It does
 * not look at `driverAi.enabled`: callers check the switch first. Throws when
 * the stored key cannot be decrypted.
 */
export function resolveDriverAiConfig(
  settings: AiSettings,
  encryptionKey: string,
  allowPrivateHosts: boolean,
): DriverAiConfig | null {
  const { provider } = settings.driver;
  if (provider === null) return null;
  const credentials = settings.providers[provider];
  if (credentials.apiKeyEnc === '') return null;
  const baseUrl = validateAiBaseUrl(credentials.baseUrl, { allowPrivateHosts });
  if (baseUrl === null) return null;
  const model =
    settings.driver.model !== '' ? settings.driver.model : getProviderEntry(provider).routerModel;
  return {
    provider,
    apiKey: decryptString(credentials.apiKeyEnc, encryptionKey),
    baseUrl,
    model,
    effort: settings.driver.effort,
    systemPrompt: settings.driver.systemPrompt.trim(),
  };
}

export function createDriverAiAdapter(config: DriverAiConfig): AiAdapter {
  return getProviderRegistry().create(config.provider, {
    apiKey: config.apiKey,
    ...(config.baseUrl !== '' ? { baseUrl: config.baseUrl } : {}),
  });
}
