// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { safeFetch } from '@evtivity/lib/safe-fetch';
import {
  TERMINAL_PROVIDER_IDS,
  TerminalProviderError,
  type PaymentTerminalProvider,
  type TerminalProviderId,
} from './types.js';
import {
  SimulatedTerminalProvider,
  type SimulatedTerminalEventSink,
} from './simulated/provider.js';
import { IdtechTerminalProvider } from './idtech/adapter.js';
import {
  IDTECH_BASE_URLS,
  IDTECH_LIVE_VERIFIED,
  IDTECH_TEST_PATH,
  type IdtechEnvironment,
} from './idtech/contract.js';

/** The decrypted terminal provider settings (`paymentTerminals.*`). */
export interface TerminalProviderSettings {
  idtech: {
    enabled: boolean;
    environment: IdtechEnvironment;
    merchantId: string;
    apiKey: string;
    apiSecret: string;
    webhookSecret: string;
  };
}

export interface PaymentTerminalRegistryOptions {
  /** Reads the decrypted settings (the caller's cached reader). */
  readSettings: () => Promise<TerminalProviderSettings>;
  /** SETTINGS_ENCRYPTION_KEY: the simulated provider derives its event signing key from it. */
  encryptionKey: string;
  /** PAYMENT_TERMINALS_ALLOW_SIMULATED: the simulated provider exists only where this is true. */
  allowSimulated: boolean;
  /**
   * NODE_ENV development or test: the ID TECH adapter may be built before its
   * contract is verified by a live sandbox run (IDTECH_LIVE_VERIFIED).
   */
  allowUnverified: boolean;
  /** PAYMENT_TERMINAL_TEST_BASE_URL (development and test): replaces the vendor host with a mock. */
  testBaseUrl?: string | null;
  /** Where the simulated async device sends its signed events. */
  simulatedEventSink?: SimulatedTerminalEventSink | null;
  /** Replaces the guarded fetch (tests). */
  fetch?: typeof fetch;
}

/** True when the ID TECH adapter may be built: verified contract, or development and test. */
export function idtechBuildAllowed(allowUnverified: boolean): boolean {
  return IDTECH_LIVE_VERIFIED || allowUnverified;
}

/** True when the ID TECH settings hold everything a call needs. */
export function idtechConfigured(settings: TerminalProviderSettings['idtech']): boolean {
  return (
    settings.enabled &&
    settings.merchantId !== '' &&
    settings.apiKey !== '' &&
    settings.apiSecret !== '' &&
    settings.webhookSecret !== ''
  );
}

interface Built {
  fingerprint: string;
  provider: PaymentTerminalProvider | null;
}

/**
 * The terminal providers of a process. An adapter is built from its settings
 * and reused until they change; a change rebuilds it, so no old credential
 * stays in use (the SIM and payment registries do the same).
 */
export class PaymentTerminalRegistry {
  private readonly options: PaymentTerminalRegistryOptions;
  private readonly built = new Map<TerminalProviderId, Built>();
  private simulated: SimulatedTerminalProvider | null = null;

  constructor(options: PaymentTerminalRegistryOptions) {
    this.options = options;
  }

  /** The provider, or null when it is off, unconfigured or not allowed in this process. */
  async getProvider(id: TerminalProviderId): Promise<PaymentTerminalProvider | null> {
    if (id === 'simulated') return this.simulatedProvider();
    const settings = await this.options.readSettings();
    const fingerprint = JSON.stringify(settings.idtech);
    const cached = this.built.get(id);
    if (cached?.fingerprint === fingerprint) return cached.provider;
    const provider = this.buildIdtech(settings);
    this.built.set(id, { fingerprint, provider });
    return provider;
  }

  /** The provider, or a `TerminalProviderError('unsupported')` when it is not available. */
  async requireProvider(id: TerminalProviderId): Promise<PaymentTerminalProvider> {
    const provider = await this.getProvider(id);
    if (provider == null) {
      throw new TerminalProviderError(
        'unsupported',
        `Payment terminal provider ${id} is not configured`,
      );
    }
    return provider;
  }

  /** The ids of the providers available now. */
  async availableProviders(): Promise<TerminalProviderId[]> {
    const ids: TerminalProviderId[] = [];
    for (const id of TERMINAL_PROVIDER_IDS) {
      if ((await this.getProvider(id)) != null) ids.push(id);
    }
    return ids;
  }

  /** Drops the built adapters (after a settings change). */
  clearCache(): void {
    this.built.clear();
  }

  private simulatedProvider(): SimulatedTerminalProvider | null {
    if (!this.options.allowSimulated) return null;
    this.simulated ??= new SimulatedTerminalProvider({
      encryptionKey: this.options.encryptionKey,
      eventSink: this.options.simulatedEventSink ?? null,
    });
    return this.simulated;
  }

  private buildIdtech(settings: TerminalProviderSettings): PaymentTerminalProvider | null {
    if (!idtechBuildAllowed(this.options.allowUnverified)) return null;
    if (!idtechConfigured(settings.idtech)) return null;
    const testBaseUrl = this.options.testBaseUrl ?? null;
    const baseUrl =
      testBaseUrl != null
        ? `${testBaseUrl}${IDTECH_TEST_PATH}`
        : IDTECH_BASE_URLS[settings.idtech.environment];
    // A mock runs on the Compose network (development and test only); the
    // vendor hosts are public, so the guard refuses any private address.
    // safeFetch returns undici's Response type, which equals the global one at
    // run time; the cast is the same as the AI adapters' guarded fetch.
    const guarded: typeof fetch = (input, init) =>
      safeFetch(input instanceof Request ? input.url : input.toString(), {
        ...((init ?? {}) as Parameters<typeof safeFetch>[1]),
        ...(testBaseUrl != null ? { allowPrivateNetworks: true } : {}),
      }) as unknown as Promise<Response>;
    return new IdtechTerminalProvider({
      baseUrl,
      merchantId: settings.idtech.merchantId,
      apiKey: settings.idtech.apiKey,
      apiSecret: settings.idtech.apiSecret,
      webhookSecret: settings.idtech.webhookSecret,
      fetch: this.options.fetch ?? guarded,
    });
  }
}
