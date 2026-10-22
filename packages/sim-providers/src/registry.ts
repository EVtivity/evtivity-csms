// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { hologramFactory } from './hologram/adapter.js';
import type { SimProvider, SimProviderId, SimProviderSettings } from './types.js';

/** The order in which a station's ICCID is looked up. A later provider is added here. */
export const SIM_PROVIDER_ORDER: readonly SimProviderId[] = ['hologram'];

export interface SimProviderBuildOptions {
  /** Development and test only: replaces the vendor host with a mock. */
  testBaseUrl: string | null;
}

export interface SimProviderFactory {
  readonly id: SimProviderId;
  /** Null when the provider is off or has no credentials. */
  create(settings: SimProviderSettings, options: SimProviderBuildOptions): SimProvider | null;
}

export interface SimProviderRegistryOptions {
  /** Reads the decrypted settings (the cached settings reader of the caller). */
  readSettings: () => Promise<SimProviderSettings>;
  /** Defaults to every built-in adapter. */
  factories?: readonly SimProviderFactory[];
  testBaseUrl?: string | null;
}

const BUILT_IN_FACTORIES: readonly SimProviderFactory[] = [hologramFactory];

interface BuiltProvider {
  fingerprint: string;
  provider: SimProvider | null;
}

/**
 * The SIM providers of a process. An adapter is built from its settings and
 * reused until they change; a change rebuilds it, so no old credential stays
 * in use.
 */
export class SimProviderRegistry {
  private readonly factories = new Map<SimProviderId, SimProviderFactory>();
  private readonly built = new Map<SimProviderId, BuiltProvider>();
  private readonly readSettings: () => Promise<SimProviderSettings>;
  private readonly testBaseUrl: string | null;

  constructor(options: SimProviderRegistryOptions) {
    this.readSettings = options.readSettings;
    this.testBaseUrl = options.testBaseUrl ?? null;
    for (const factory of options.factories ?? BUILT_IN_FACTORIES) {
      if (this.factories.has(factory.id)) {
        throw new Error(`SIM provider ${factory.id} is registered twice`);
      }
      this.factories.set(factory.id, factory);
    }
  }

  /** The enabled providers with credentials, in lookup order. */
  async enabledProviders(): Promise<SimProvider[]> {
    const settings = await this.readSettings();
    const providers: SimProvider[] = [];
    for (const id of SIM_PROVIDER_ORDER) {
      const provider = this.build(id, settings);
      if (provider != null) providers.push(provider);
    }
    return providers;
  }

  /** The provider with this id, or null when it is off or has no credentials. */
  async getProvider(id: SimProviderId): Promise<SimProvider | null> {
    return this.build(id, await this.readSettings());
  }

  /** Drops the built adapters (after a settings change). */
  clearCache(): void {
    this.built.clear();
  }

  private build(id: SimProviderId, settings: SimProviderSettings): SimProvider | null {
    const factory = this.factories.get(id);
    if (factory == null) return null;
    const fingerprint = JSON.stringify(settings[id]);
    const cached = this.built.get(id);
    if (cached?.fingerprint === fingerprint) return cached.provider;
    const provider = factory.create(settings, { testBaseUrl: this.testBaseUrl });
    this.built.set(id, { fingerprint, provider });
    return provider;
  }
}
