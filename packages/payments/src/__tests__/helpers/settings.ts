// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AdyenSettings, SimulatedSettings } from '../../settings.js';

/** Adyen settings as read from a database where nothing is configured. */
export function emptyAdyenSettings(overrides: Partial<AdyenSettings> = {}): AdyenSettings {
  return {
    apiKey: null,
    merchantAccount: null,
    clientKey: null,
    environment: 'test',
    liveUrlPrefix: null,
    liveRegion: 'eu',
    hmacKey: null,
    hmacKeyPrevious: null,
    webhookUsername: null,
    webhookPassword: null,
    authorisationAdjustment: false,
    ...overrides,
  };
}

/**
 * Simulated provider settings as seeded (migration 0125). A literal, not
 * DEFAULT_SIMULATED_SETTINGS: importing settings.ts here would load it before
 * the tests' database mocks.
 */
export function defaultSimulatedSettings(
  overrides: Partial<SimulatedSettings> = {},
): SimulatedSettings {
  return { resultMode: 'sync', asyncDelaySeconds: 3, randomFailureRate: 0.2, ...overrides };
}
