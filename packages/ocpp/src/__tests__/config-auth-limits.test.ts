// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OcppConfig } from '../lib/config.js';

const REQUIRED = { OCPP_PORT: '8080', SETTINGS_ENCRYPTION_KEY: 'k' };

async function loadConfig(env: Record<string, string | undefined>): Promise<OcppConfig> {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...env })) vi.stubEnv(key, value);
  const { config } = await import('../lib/config.js');
  return config;
}

describe('connection authentication limits', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are unset by default, and an empty value (compose) counts as unset', async () => {
    const config = await loadConfig({
      OCPP_AUTH_MAX_CONCURRENT: undefined,
      OCPP_AUTH_MAX_QUEUED: '',
      OCPP_AUTH_MAX_WAIT_MS: undefined,
    });
    expect(config.OCPP_AUTH_MAX_CONCURRENT).toBeUndefined();
    expect(config.OCPP_AUTH_MAX_QUEUED).toBeUndefined();
    expect(config.OCPP_AUTH_MAX_WAIT_MS).toBeUndefined();
  });

  it('parse whole numbers; the queue may be 0', async () => {
    const config = await loadConfig({
      OCPP_AUTH_MAX_CONCURRENT: '8',
      OCPP_AUTH_MAX_QUEUED: '0',
      OCPP_AUTH_MAX_WAIT_MS: '5000',
    });
    expect(config.OCPP_AUTH_MAX_CONCURRENT).toBe(8);
    expect(config.OCPP_AUTH_MAX_QUEUED).toBe(0);
    expect(config.OCPP_AUTH_MAX_WAIT_MS).toBe(5000);
  });

  it('reject zero concurrency and values that are not whole numbers', async () => {
    await expect(loadConfig({ OCPP_AUTH_MAX_CONCURRENT: '0' })).rejects.toThrow();
    await expect(loadConfig({ OCPP_AUTH_MAX_WAIT_MS: 'soon' })).rejects.toThrow();
    await expect(loadConfig({ OCPP_AUTH_MAX_QUEUED: '-1' })).rejects.toThrow();
  });
});
