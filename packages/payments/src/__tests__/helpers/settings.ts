// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AdyenSettings } from '../../settings.js';

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
