// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';

const REQUIRED = { API_PORT: '3001', SETTINGS_ENCRYPTION_KEY: 'k' };
const MOCK = 'http://sim-mock:8080';

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({
    ...REQUIRED,
    SIM_PROVIDER_TEST_BASE_URL: undefined,
    ...env,
  })) {
    vi.stubEnv(key, value);
  }
  const { config } = await import('../lib/config.js');
  return config;
}

describe('SIM provider test base URL config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off by default, in development and in production', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const config = await loadConfig({ NODE_ENV });
      expect(config.SIM_PROVIDER_TEST_BASE_URL).toBeUndefined();
    }
  });

  it('treats an empty value as unset in production', async () => {
    const config = await loadConfig({ NODE_ENV: 'production', SIM_PROVIDER_TEST_BASE_URL: '' });
    expect(config.SIM_PROVIDER_TEST_BASE_URL).toBeUndefined();
  });

  it('accepts the mock URL in development and test', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const config = await loadConfig({ NODE_ENV, SIM_PROVIDER_TEST_BASE_URL: MOCK });
      expect(config.SIM_PROVIDER_TEST_BASE_URL).toBe(MOCK);
    }
  });

  it('refuses to start with the URL when NODE_ENV is production or unset', async () => {
    for (const NODE_ENV of ['production', undefined]) {
      await expect(loadConfig({ NODE_ENV, SIM_PROVIDER_TEST_BASE_URL: MOCK })).rejects.toThrow(
        /SIM_PROVIDER_TEST_BASE_URL needs NODE_ENV development or test/,
      );
    }
  });

  it('refuses to start with a URL that is not http or https', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'development', SIM_PROVIDER_TEST_BASE_URL: 'ftp://sim-mock' }),
    ).rejects.toThrow(/http or https/);
  });
});
