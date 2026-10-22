// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  clearSimSettingsCache,
  getSimProviderSettings,
  type SimSettings,
} from '@evtivity/database';
import { getSimProviderTestBaseUrl } from '@evtivity/lib/sim-test-base-url';
import { createSimProviderRegistry } from '@evtivity/services/station-sim.service';
import { config } from './config.js';

type SimProviderRegistry = ReturnType<typeof createSimProviderRegistry>;

let registry: SimProviderRegistry | undefined;

export function simEncryptionKey(): string {
  const key = config.SETTINGS_ENCRYPTION_KEY;
  if (key === '') throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  return key;
}

/** The SIM providers of this API process. */
export function simProviderRegistry(): SimProviderRegistry {
  registry ??= createSimProviderRegistry(simEncryptionKey(), getSimProviderTestBaseUrl());
  return registry;
}

/** The SIM settings, read through the 60 s cache. */
export async function readSimSettings(): Promise<SimSettings> {
  return getSimProviderSettings(simEncryptionKey());
}

/** A SIM provider or station signal reads are on; with both off nothing SIM related runs. */
export function isSimFeatureOn(simSettings: SimSettings): boolean {
  return simSettings.hologram.enabled || simSettings.stationSignalEnabled;
}

/** After a SIM settings write: the next read and every adapter use the new values. */
export function clearSimCaches(): void {
  clearSimSettingsCache();
  registry?.clearCache();
}
