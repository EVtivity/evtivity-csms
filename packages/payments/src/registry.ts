// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderNotConfiguredError } from './errors.js';
import { getPaymentSettings, NO_PAYMENT_PROVIDER } from './settings.js';
import type { PaymentSettings } from './settings.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';

export interface PaymentProviderFactory {
  readonly id: PaymentProviderId;
  /** Built from the decrypted settings; null when the provider is not configured. */
  create(settings: PaymentSettings): Promise<PaymentProvider | null>;
}

export interface PaymentRegistryOptions {
  /** The process's SETTINGS_ENCRYPTION_KEY (never read from process.env here). */
  encryptionKey: string;
  /** Reads the settings; defaults to the cached getPaymentSettings. */
  readSettings?: (encryptionKey: string) => Promise<PaymentSettings>;
}

/**
 * The providers a process can use. A provider instance is built from the
 * settings and reused while they are unchanged (the settings reader caches
 * them for 60 s), so a payment never builds a new client per call (P6).
 *
 * A record is captured, cancelled and refunded by the provider stored on it
 * (getPaymentProvider), never the active one, so switching providers never
 * strands a hold (P11). getActivePaymentProvider is for new payments only.
 */
export class PaymentProviderRegistry {
  private readonly factories = new Map<PaymentProviderId, PaymentProviderFactory>();
  private readonly instances = new Map<
    PaymentProviderId,
    { settings: PaymentSettings; provider: PaymentProvider | null }
  >();
  private readonly encryptionKey: string;
  private readonly readSettings: (encryptionKey: string) => Promise<PaymentSettings>;

  constructor(options: PaymentRegistryOptions) {
    this.encryptionKey = options.encryptionKey;
    this.readSettings = options.readSettings ?? getPaymentSettings;
  }

  register(factory: PaymentProviderFactory): void {
    if (factory.id === NO_PAYMENT_PROVIDER) {
      throw new Error(`'${NO_PAYMENT_PROVIDER}' is reserved and cannot be a provider id`);
    }
    if (this.factories.has(factory.id)) {
      throw new Error(`Payment provider ${factory.id} is already registered`);
    }
    this.factories.set(factory.id, factory);
  }

  isRegistered(id: PaymentProviderId): boolean {
    return this.factories.has(id);
  }

  registeredIds(): PaymentProviderId[] {
    return [...this.factories.keys()];
  }

  /**
   * The provider with this id. Throws PaymentProviderNotConfiguredError when it
   * is not registered in this process (a refused simulated provider) or has no
   * credentials.
   */
  async getPaymentProvider(id: PaymentProviderId): Promise<PaymentProvider> {
    const provider = await this.build(id);
    if (provider == null) throw new PaymentProviderNotConfiguredError(id);
    return provider;
  }

  /**
   * The provider selected by `payments.provider` for new payments, or null when
   * payments are off ('none') or the selected provider has no credentials. An
   * id this process does not know throws (fail loud).
   */
  async getActivePaymentProvider(): Promise<PaymentProvider | null> {
    const settings = await this.readSettings(this.encryptionKey);
    if (settings.provider === NO_PAYMENT_PROVIDER) return null;
    if (!this.factories.has(settings.provider)) {
      throw new PaymentProviderNotConfiguredError(
        settings.provider,
        `payments.provider is ${settings.provider}, which is not available in this process`,
      );
    }
    return this.build(settings.provider);
  }

  /** The payment settings this registry builds providers from (cached reader). */
  settings(): Promise<PaymentSettings> {
    return this.readSettings(this.encryptionKey);
  }

  /** Drop the built providers (after a settings change; pair with clearPaymentSettingsCache). */
  clearCache(): void {
    this.instances.clear();
  }

  private async build(id: PaymentProviderId): Promise<PaymentProvider | null> {
    const factory = this.factories.get(id);
    if (factory == null) {
      throw new PaymentProviderNotConfiguredError(
        id,
        `Payment provider ${id} is not available in this process`,
      );
    }
    const settings = await this.readSettings(this.encryptionKey);
    const cached = this.instances.get(id);
    if (cached != null && cached.settings === settings) return cached.provider;
    const provider = await factory.create(settings);
    this.instances.set(id, { settings, provider });
    return provider;
  }
}
