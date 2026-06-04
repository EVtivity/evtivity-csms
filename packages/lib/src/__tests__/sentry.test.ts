// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const initMock = vi.fn();

vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
}));

async function freshInitSentry(): Promise<(typeof import('../sentry.js'))['initSentry']> {
  vi.resetModules();
  const mod = await import('../sentry.js');
  return mod.initSentry;
}

describe('initSentry', () => {
  beforeEach(() => {
    initMock.mockClear();
  });

  it('calls Sentry.init with the expected config when enabled and a DSN is set', async () => {
    const initSentry = await freshInitSentry();
    initSentry('api-service', {
      enabled: true,
      dsn: 'https://abc@o123.ingest.sentry.io/456',
      environment: 'production',
    });

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith({
      dsn: 'https://abc@o123.ingest.sentry.io/456',
      environment: 'production',
      serverName: 'api-service',
      tracesSampleRate: 0.1,
    });
  });

  it('skips init when disabled even if a DSN is present', async () => {
    const initSentry = await freshInitSentry();
    initSentry('api-service', {
      enabled: false,
      dsn: 'https://abc@o123.ingest.sentry.io/456',
      environment: 'production',
    });

    expect(initMock).not.toHaveBeenCalled();
  });

  it('skips init when the DSN is an empty string even if enabled', async () => {
    const initSentry = await freshInitSentry();
    initSentry('ocpp-service', {
      enabled: true,
      dsn: '',
      environment: 'staging',
    });

    expect(initMock).not.toHaveBeenCalled();
  });

  it('only initializes once across repeated calls', async () => {
    const initSentry = await freshInitSentry();
    const config = {
      enabled: true,
      dsn: 'https://abc@o123.ingest.sentry.io/456',
      environment: 'production',
    };

    initSentry('api-service', config);
    initSentry('api-service', config);
    initSentry('another-service', config);

    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('does not initialize on a later call once a disabled call has guarded nothing', async () => {
    const initSentry = await freshInitSentry();

    // First call is disabled: must not set the initialized flag, so a later
    // enabled call still initializes.
    initSentry('svc', { enabled: false, dsn: '', environment: 'dev' });
    expect(initMock).not.toHaveBeenCalled();

    initSentry('svc', {
      enabled: true,
      dsn: 'https://abc@o123.ingest.sentry.io/456',
      environment: 'dev',
    });
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
