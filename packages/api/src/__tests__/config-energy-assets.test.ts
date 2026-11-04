// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';

const REQUIRED = {
  API_PORT: '3001',
  SETTINGS_ENCRYPTION_KEY: 'k',
  JWT_SECRET: 'unit-test-jwt-secret-of-at-least-32-characters',
};

async function allowSimulated(env: Record<string, string | undefined>): Promise<boolean> {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...env })) vi.stubEnv(key, value);
  const { config } = await import('../lib/config.js');
  return config.ENERGY_ASSETS_ALLOW_SIMULATED;
}

describe('ENERGY_ASSETS_ALLOW_SIMULATED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to on in development and test only', async () => {
    const unset = { ENERGY_ASSETS_ALLOW_SIMULATED: undefined };
    expect(await allowSimulated({ ...unset, NODE_ENV: 'development' })).toBe(true);
    expect(await allowSimulated({ ...unset, NODE_ENV: 'test' })).toBe(true);
  });

  it('defaults to off in production and when NODE_ENV is unset', async () => {
    const unset = { ENERGY_ASSETS_ALLOW_SIMULATED: undefined };
    expect(await allowSimulated({ ...unset, NODE_ENV: 'production' })).toBe(false);
    expect(await allowSimulated({ ...unset, NODE_ENV: undefined })).toBe(false);
  });

  it('follows an explicit value and rejects anything else', async () => {
    expect(
      await allowSimulated({ NODE_ENV: 'production', ENERGY_ASSETS_ALLOW_SIMULATED: 'true' }),
    ).toBe(true);
    expect(
      await allowSimulated({ NODE_ENV: 'development', ENERGY_ASSETS_ALLOW_SIMULATED: 'false' }),
    ).toBe(false);
    await expect(allowSimulated({ ENERGY_ASSETS_ALLOW_SIMULATED: 'yes' })).rejects.toThrow();
  });
});
