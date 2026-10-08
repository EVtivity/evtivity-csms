// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';

const REQUIRED = { API_PORT: '3001', SETTINGS_ENCRYPTION_KEY: 'k' };
const UNSET = { NOTIFICATIONS_ALLOW_TEST_SINK: undefined, NOTIFICATIONS_TEST_SINK_URL: undefined };
const SINK = 'http://notify-sink:8080';

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...UNSET, ...env })) {
    vi.stubEnv(key, value);
  }
  const { config } = await import('../lib/config.js');
  return config;
}

describe('notification test sink config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off by default, in development and in production', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const config = await loadConfig({ NODE_ENV });
      expect(config.NOTIFICATIONS_ALLOW_TEST_SINK).toBe(false);
      expect(config.NOTIFICATIONS_TEST_SINK_URL).toBeUndefined();
    }
  });

  it('accepts the sink in development or test with the allow flag', async () => {
    const config = await loadConfig({
      NODE_ENV: 'development',
      NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
      NOTIFICATIONS_TEST_SINK_URL: SINK,
    });
    expect(config.NOTIFICATIONS_ALLOW_TEST_SINK).toBe(true);
    expect(config.NOTIFICATIONS_TEST_SINK_URL).toBe(SINK);
  });

  it('refuses to start with the allow flag when NODE_ENV is production', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'production', NOTIFICATIONS_ALLOW_TEST_SINK: 'true' }),
    ).rejects.toThrow(/needs NODE_ENV development or test/);
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
        NOTIFICATIONS_TEST_SINK_URL: SINK,
      }),
    ).rejects.toThrow(/needs NODE_ENV development or test/);
  });

  it('refuses to start with the allow flag when NODE_ENV is unset', async () => {
    await expect(
      loadConfig({
        NODE_ENV: undefined,
        NOTIFICATIONS_ALLOW_TEST_SINK: 'true',
        NOTIFICATIONS_TEST_SINK_URL: SINK,
      }),
    ).rejects.toThrow(/needs NODE_ENV development or test/);
  });

  it('refuses a sink URL without the allow flag, and invalid values', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'development', NOTIFICATIONS_TEST_SINK_URL: SINK }),
    ).rejects.toThrow(/needs NOTIFICATIONS_ALLOW_TEST_SINK=true/);
    await expect(loadConfig({ NOTIFICATIONS_ALLOW_TEST_SINK: 'yes' })).rejects.toThrow();
    await expect(
      loadConfig({ NOTIFICATIONS_ALLOW_TEST_SINK: 'true', NOTIFICATIONS_TEST_SINK_URL: 'sink' }),
    ).rejects.toThrow();
  });
});
