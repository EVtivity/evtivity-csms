// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';

const REQUIRED = { OCPP_PORT: '8080', SETTINGS_ENCRYPTION_KEY: 'k' };

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

  it('defaults to on in development, test, and when NODE_ENV is unset', async () => {
    const unset = { PAYMENTS_ALLOW_SIMULATED: undefined };
    expect(await allowSimulated({ ...unset, NODE_ENV: 'development' })).toBe(true);
    expect(await allowSimulated({ ...unset, NODE_ENV: 'test' })).toBe(true);
    expect(await allowSimulated({ ...unset, NODE_ENV: undefined })).toBe(true);
  });

  it('defaults to off in production', async () => {
    expect(
      await allowSimulated({ PAYMENTS_ALLOW_SIMULATED: undefined, NODE_ENV: 'production' }),
    ).toBe(false);
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
