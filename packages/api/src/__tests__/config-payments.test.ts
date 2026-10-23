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
  return config.PAYMENTS_ALLOW_SIMULATED;
}

describe('PAYMENTS_ALLOW_SIMULATED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to on in development and test only', async () => {
    const unset = { PAYMENTS_ALLOW_SIMULATED: undefined };
    expect(await allowSimulated({ ...unset, NODE_ENV: 'development' })).toBe(true);
    expect(await allowSimulated({ ...unset, NODE_ENV: 'test' })).toBe(true);
  });

  it('defaults to off in production and when NODE_ENV is unset', async () => {
    const unset = { PAYMENTS_ALLOW_SIMULATED: undefined };
    expect(await allowSimulated({ ...unset, NODE_ENV: 'production' })).toBe(false);
    expect(await allowSimulated({ ...unset, NODE_ENV: undefined })).toBe(false);
  });

  it('follows an explicit value and rejects anything else', async () => {
    expect(await allowSimulated({ NODE_ENV: 'production', PAYMENTS_ALLOW_SIMULATED: 'true' })).toBe(
      true,
    );
    expect(
      await allowSimulated({ NODE_ENV: 'development', PAYMENTS_ALLOW_SIMULATED: 'false' }),
    ).toBe(false);
    await expect(allowSimulated({ PAYMENTS_ALLOW_SIMULATED: 'yes' })).rejects.toThrow();
  });
});

describe('NODE_ENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('counts an unset NODE_ENV as production', async () => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED)) vi.stubEnv(key, value);
    vi.stubEnv('NODE_ENV', undefined);
    const { config } = await import('../lib/config.js');
    expect(config.NODE_ENV).toBe('production');
  });
});

describe('JWT_SECRET', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function load(env: Record<string, string | undefined>): Promise<unknown> {
    vi.resetModules();
    for (const [key, value] of Object.entries({ ...REQUIRED, ...env })) vi.stubEnv(key, value);
    return (await import('../lib/config.js')).config;
  }

  it.each(['dev-jwt-secret-change-in-production!!', 'dev-secret-change-in-production', 'short'])(
    'refuses the weak or published secret %s outside the unit tests',
    async (secret) => {
      await expect(load({ NODE_ENV: 'production', JWT_SECRET: secret })).rejects.toThrow(
        /JWT_SECRET must be at least 32 characters/,
      );
      await expect(load({ NODE_ENV: 'development', JWT_SECRET: secret })).rejects.toThrow(
        /JWT_SECRET/,
      );
    },
  );

  it('refuses an unset secret, which falls back to the published default', async () => {
    await expect(load({ NODE_ENV: 'production', JWT_SECRET: undefined })).rejects.toThrow(
      /JWT_SECRET/,
    );
  });

  it('refuses a TRUST_PROXY CIDR that trusts every address', async () => {
    await expect(load({ NODE_ENV: 'production', TRUST_PROXY: '0.0.0.0/0' })).rejects.toThrow(
      /every address/,
    );
  });
});
