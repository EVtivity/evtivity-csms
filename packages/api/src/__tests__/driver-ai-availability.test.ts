// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAiSettings } from '@evtivity/lib/ai-config';
import type { AiSettings } from '@evtivity/lib/ai-config';

const state = vi.hoisted((): { settings: AiSettings | null; fail: boolean } => ({
  settings: null,
  fail: false,
}));

vi.mock('@evtivity/database', () => ({
  getAiSettings: () =>
    state.fail ? Promise.reject(new Error('db down')) : Promise.resolve(state.settings),
}));

vi.mock('../lib/config.js', () => ({ config: { NODE_ENV: 'test' } }));

import { readDriverAiAvailability } from '../lib/driver-ai-availability.js';

function settings(rows: Array<{ key: string; value: unknown }>): AiSettings {
  return buildAiSettings(rows);
}

describe('readDriverAiAvailability', () => {
  beforeEach(() => {
    state.fail = false;
    state.settings = settings([]);
  });

  it('TC-AI-DR-03 is off by default', async () => {
    expect(await readDriverAiAvailability()).toEqual({ available: false, perMinute: 2 });
  });

  it('TC-AI-DR-03 is on with driverAi.enabled and a provider key', async () => {
    state.settings = settings([
      { key: 'driverAi.enabled', value: true },
      { key: 'driverAi.provider', value: 'deepseek' },
      { key: 'ai.deepseek.apiKeyEnc', value: 'ciphertext' },
      { key: 'ai.rateLimit.driverPerMinute', value: 5 },
    ]);
    expect(await readDriverAiAvailability()).toEqual({ available: true, perMinute: 5 });
  });

  it('TC-AI-DR-03 is off when enabled without a key for the provider', async () => {
    state.settings = settings([
      { key: 'driverAi.enabled', value: true },
      { key: 'driverAi.provider', value: 'deepseek' },
    ]);
    expect((await readDriverAiAvailability()).available).toBe(false);
  });

  it('TC-AI-DR-03 fails closed when the settings cannot be read', async () => {
    state.fail = true;
    expect(await readDriverAiAvailability()).toEqual({ available: false, perMinute: 0 });
  });
});
