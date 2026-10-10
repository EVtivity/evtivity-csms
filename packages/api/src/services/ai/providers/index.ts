// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Adapter factories for the provider registry. Adding a provider means one
 * folder under `providers/`, one entry here, its model-registry entry, its
 * settings keys and its contract fixtures.
 */

import { createProviderRegistry } from '../core/provider-registry.js';
import type { ProviderRegistry } from '../core/provider-registry.js';
import type { AiAdapterFactory, ProviderId } from '../core/types.js';
import { createAnthropicAdapter } from './anthropic/adapter.js';
import { createDeepSeekAdapter } from './deepseek/adapter.js';
import { createGeminiAdapter } from './gemini/adapter.js';
import { createOpenAiAdapter } from './openai/adapter.js';

export const PROVIDER_ADAPTER_FACTORIES: Readonly<Record<ProviderId, AiAdapterFactory>> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAiAdapter,
  gemini: createGeminiAdapter,
  deepseek: createDeepSeekAdapter,
};

let defaultRegistry: ProviderRegistry | undefined;

/** The registry with every built-in adapter. */
export function getProviderRegistry(): ProviderRegistry {
  defaultRegistry ??= createProviderRegistry(PROVIDER_ADAPTER_FACTORIES);
  return defaultRegistry;
}

export { createAnthropicAdapter, createDeepSeekAdapter, createGeminiAdapter, createOpenAiAdapter };
