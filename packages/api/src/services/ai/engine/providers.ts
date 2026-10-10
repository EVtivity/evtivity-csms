// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The provider registry the engine creates adapters from: the built-in
 * adapters of `providers/` in production; tests install a registry of
 * scripted adapters with `setAiProviderRegistry`.
 */

import type { ProviderRegistry } from '../core/provider-registry.js';
import type { AiAdapter, ProviderId } from '../core/types.js';
import { getProviderRegistry } from '../providers/index.js';
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

/** The adapter for a resolved surface configuration. */
export function createAdapterFor(config: AiSurfaceConfig): AiAdapter {
  return registry().create(config.provider, {
    apiKey: config.apiKey,
    ...(config.baseUrl !== '' ? { baseUrl: config.baseUrl } : {}),
  });
}
