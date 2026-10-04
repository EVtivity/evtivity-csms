// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderRegistry } from './registry.js';
import type { PaymentRegistryOptions } from './registry.js';
import { simulatedProviderFactory } from './providers/simulated/index.js';
import type { SimulatedFactoryOptions } from './providers/simulated/index.js';
import { stripeProviderFactory } from './providers/stripe/index.js';
import { adyenProviderFactory } from './providers/adyen/index.js';

export interface CreatePaymentRegistryOptions extends PaymentRegistryOptions {
  /**
   * The process's PAYMENTS_ALLOW_SIMULATED. When false the simulated provider
   * is not registered: selecting it or using a record pinned to it fails loud.
   */
  allowSimulated: boolean;
  /** Process options of the simulated provider; its result mode, delay and failure rate are the `simulated.*` settings. */
  simulated?: Omit<SimulatedFactoryOptions, 'encryptionKey'>;
}

/** The registry each process builds once at startup, with the built-in providers. */
export function createPaymentRegistry(
  options: CreatePaymentRegistryOptions,
): PaymentProviderRegistry {
  const registry = new PaymentProviderRegistry(options);
  registry.register(stripeProviderFactory);
  registry.register(adyenProviderFactory);
  if (options.allowSimulated) {
    registry.register(
      simulatedProviderFactory({ ...options.simulated, encryptionKey: options.encryptionKey }),
    );
  }
  return registry;
}
