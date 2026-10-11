// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Provider name to adapter factory. The only place a provider id selects
 * code: callers pass the configured id and get an `AiAdapter`. The adapters
 * module (`providers/index.ts`, lane L1) supplies the factories; tests pass
 * fakes.
 */

import { PROVIDER_IDS } from './types.js';
import type { AiAdapter, AiAdapterFactory, AiAdapterOptions, ProviderId } from './types.js';

export class UnknownProviderError extends Error {
  constructor(readonly provider: string) {
    super(`No AI adapter is registered for provider "${provider}"`);
    this.name = 'UnknownProviderError';
  }
}

export interface ProviderRegistry {
  has(provider: ProviderId): boolean;
  /** Providers with a registered adapter, in `PROVIDER_IDS` order. */
  available(): ProviderId[];
  create(provider: ProviderId, options: AiAdapterOptions): AiAdapter;
}

export function createProviderRegistry(
  factories: Partial<Record<ProviderId, AiAdapterFactory>>,
): ProviderRegistry {
  const map = new Map<ProviderId, AiAdapterFactory>();
  for (const id of PROVIDER_IDS) {
    const factory = factories[id];
    if (factory !== undefined) map.set(id, factory);
  }
  return {
    has: (provider) => map.has(provider),
    available: () => PROVIDER_IDS.filter((id) => map.has(id)),
    create(provider, options) {
      const factory = map.get(provider);
      if (factory === undefined) throw new UnknownProviderError(provider);
      const adapter = factory(options);
      if (adapter.provider !== provider) {
        throw new Error(
          `Adapter factory for "${provider}" returned an adapter for "${adapter.provider}"`,
        );
      }
      return adapter;
    },
  };
}
