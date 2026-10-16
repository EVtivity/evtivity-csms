// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The provider registry the engine creates adapters from: the built-in
 * adapters of `providers/` in production; tests install a registry of
 * scripted adapters with `setAiProviderRegistry`.
 */

import type { ProviderRegistry, AiAdapter, ProviderId } from '@evtivity/ai/core';
import { getProviderRegistry } from '@evtivity/ai/providers';
import { trackAiProviderCalls } from '@evtivity/services/ai-alerts';
import type { AiSurfaceConfig } from '../surfaces/config.js';

let override: ProviderRegistry | null = null;

function registry(): ProviderRegistry {
  return override ?? getProviderRegistry();
}

/** Tests replace the registry; null restores the built-in one. */
export function setAiProviderRegistry(next: ProviderRegistry | null): void {
  override = next;
}

export function hasAiAdapter(provider: ProviderId): boolean {
  return registry().has(provider);
}

/**
 * The adapter for a resolved surface configuration. Calls with the company
 * key (`source: 'system'`) keep the provider quota alert state; a personal
 * key belongs to another provider account and leaves it alone.
 */
export function createAdapterFor(config: AiSurfaceConfig): AiAdapter {
  const adapter = registry().create(config.provider, {
    apiKey: config.apiKey,
    ...(config.baseUrl !== '' ? { baseUrl: config.baseUrl } : {}),
  });
  return config.source === 'system' ? trackAiProviderCalls(adapter) : adapter;
}
