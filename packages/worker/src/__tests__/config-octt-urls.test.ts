// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../lib/config.js';

async function loadConfig(env: Record<string, string | undefined>): Promise<WorkerConfig> {
  vi.resetModules();
  vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'k');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { config } = await import('../lib/config.js');
  return config;
}

describe('OCTT run URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('default to the local stack', async () => {
    const config = await loadConfig({ OCPP_SERVER_URL: undefined, API_BASE_URL: undefined });
    expect(config.OCPP_SERVER_URL).toBe('ws://localhost:7103');
    expect(config.API_BASE_URL).toBe('http://localhost:7102');
  });

  it('take the in-cluster service addresses', async () => {
    const config = await loadConfig({
      OCPP_SERVER_URL: 'ws://evtivity-csms-ocpp:7103',
      API_BASE_URL: 'http://evtivity-csms-api:7102',
    });
    expect(config.OCPP_SERVER_URL).toBe('ws://evtivity-csms-ocpp:7103');
    expect(config.API_BASE_URL).toBe('http://evtivity-csms-api:7102');
  });

  it('reject a value that is not a URL', async () => {
    await expect(loadConfig({ API_BASE_URL: 'api 7102' })).rejects.toThrow();
  });
});
