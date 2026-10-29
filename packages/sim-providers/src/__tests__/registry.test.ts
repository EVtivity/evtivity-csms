// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { SIM_PROVIDER_ORDER, SimProviderRegistry } from '../registry.js';
import type { SimProviderFactory } from '../registry.js';
import { oneNceFactory } from '../1nce/adapter.js';
import { SimProviderError } from '../types.js';
import type { SimProvider, SimProviderId, SimProviderSettings } from '../types.js';

function settings(
  overrides: Partial<SimProviderSettings['hologram']> = {},
  oneNce: Partial<SimProviderSettings['1nce']> = {},
): SimProviderSettings {
  return {
    hologram: { enabled: false, apiKey: '', orgId: '', ...overrides },
    '1nce': { enabled: false, clientId: '', clientSecret: '', ...oneNce },
  };
}

function fakeProvider(label: string, id: SimProviderId = 'hologram'): SimProvider {
  return {
    id,
    label,
    capabilities: {
      networkName: true,
      radioAccessTechnology: true,
      cellId: true,
      usage: true,
      sessions: true,
      alerts: true,
      networkReset: true,
    },
    historyDays: 90,
    reportingDelayHours: 6,
    findByIccid: vi.fn(),
    getStatus: vi.fn(),
    listSessions: vi.fn(),
    listAlerts: vi.fn(),
    resetNetwork: vi.fn(),
    testConnection: vi.fn(),
  } as unknown as SimProvider;
}

function fakeFactory(): SimProviderFactory & { create: ReturnType<typeof vi.fn> } {
  let built = 0;
  const create = vi.fn((s: SimProviderSettings) => {
    if (!s.hologram.enabled || s.hologram.apiKey === '') return null;
    built += 1;
    return fakeProvider(`build-${String(built)}`);
  });
  return { id: 'hologram', create };
}

function fakeOneNceFactory(): SimProviderFactory & { create: ReturnType<typeof vi.fn> } {
  let built = 0;
  const create = vi.fn((s: SimProviderSettings) => {
    if (!s['1nce'].enabled || s['1nce'].clientSecret === '') return null;
    built += 1;
    return fakeProvider(`1nce-${String(built)}`, '1nce');
  });
  return { id: '1nce', create };
}

describe('SimProviderRegistry', () => {
  it('looks up Hologram first, then 1NCE', () => {
    expect(SIM_PROVIDER_ORDER).toEqual(['hologram', '1nce']);
  });

  it('returns both enabled providers in the lookup order', async () => {
    const registry = new SimProviderRegistry({
      readSettings: () =>
        Promise.resolve(
          settings(
            { enabled: true, apiKey: 'key', orgId: '42' },
            { enabled: true, clientId: 'client', clientSecret: 'secret' },
          ),
        ),
      factories: [fakeOneNceFactory(), fakeFactory()],
    });
    const providers = await registry.enabledProviders();
    expect(providers.map((p) => p.id)).toEqual(['hologram', '1nce']);
  });

  it('rebuilds only the 1NCE adapter when only its settings change', async () => {
    const hologram = fakeFactory();
    const oneNce = fakeOneNceFactory();
    let current = settings(
      { enabled: true, apiKey: 'key', orgId: '42' },
      { enabled: true, clientId: 'client', clientSecret: 'old' },
    );
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(current),
      factories: [hologram, oneNce],
    });
    await registry.enabledProviders();
    current = settings(
      { enabled: true, apiKey: 'key', orgId: '42' },
      { enabled: true, clientId: 'client', clientSecret: 'new' },
    );
    await registry.enabledProviders();
    expect(hologram.create).toHaveBeenCalledTimes(1);
    expect(oneNce.create).toHaveBeenCalledTimes(2);
  });

  it('builds no 1NCE adapter while it is off, without a secret or with a bad client id', () => {
    const options = { testBaseUrl: null };
    expect(oneNceFactory.create(settings(), options)).toBeNull();
    expect(
      oneNceFactory.create(
        settings({}, { enabled: false, clientId: 'client', clientSecret: 'secret' }),
        options,
      ),
    ).toBeNull();
    expect(
      oneNceFactory.create(
        settings({}, { enabled: true, clientId: 'client', clientSecret: ' ' }),
        options,
      ),
    ).toBeNull();
    expect(
      oneNceFactory.create(
        settings({}, { enabled: true, clientId: 'bad:id', clientSecret: 'secret' }),
        options,
      ),
    ).toBeNull();
  });

  it('returns no provider when none is enabled', async () => {
    const factory = fakeFactory();
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(settings()),
      factories: [factory],
    });
    expect(await registry.enabledProviders()).toEqual([]);
    expect(await registry.getProvider('hologram')).toBeNull();
  });

  it('returns an enabled provider with credentials', async () => {
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(settings({ enabled: true, apiKey: 'key', orgId: '42' })),
      factories: [fakeFactory()],
    });
    const providers = await registry.enabledProviders();
    expect(providers.map((p) => p.id)).toEqual(['hologram']);
  });

  it('reuses the built adapter while the settings are unchanged', async () => {
    const factory = fakeFactory();
    const registry = new SimProviderRegistry({
      // A fresh but equal object each read, as a settings reader returns after its cache expires.
      readSettings: () => Promise.resolve(settings({ enabled: true, apiKey: 'key', orgId: '42' })),
      factories: [factory],
    });
    const first = await registry.getProvider('hologram');
    const second = await registry.getProvider('hologram');
    expect(second).toBe(first);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the adapter when its settings change, so no old credential is kept', async () => {
    const factory = fakeFactory();
    let current = settings({ enabled: true, apiKey: 'old-key', orgId: '42' });
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(current),
      factories: [factory],
    });
    const first = await registry.getProvider('hologram');
    current = settings({ enabled: true, apiKey: 'new-key', orgId: '42' });
    const second = await registry.getProvider('hologram');
    expect(second).not.toBe(first);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(factory.create.mock.calls[1]?.[0]).toEqual(current);
  });

  it('drops the adapter when the provider is turned off', async () => {
    let current = settings({ enabled: true, apiKey: 'key', orgId: '42' });
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(current),
      factories: [fakeFactory()],
    });
    expect(await registry.getProvider('hologram')).not.toBeNull();
    current = settings({ enabled: false, apiKey: 'key', orgId: '42' });
    expect(await registry.getProvider('hologram')).toBeNull();
    expect(await registry.enabledProviders()).toEqual([]);
  });

  it('rebuilds after clearCache', async () => {
    const factory = fakeFactory();
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(settings({ enabled: true, apiKey: 'key', orgId: '42' })),
      factories: [factory],
    });
    await registry.getProvider('hologram');
    registry.clearCache();
    await registry.getProvider('hologram');
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it('passes the test base URL to the factory', async () => {
    const factory = fakeFactory();
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(settings({ enabled: true, apiKey: 'key', orgId: '42' })),
      factories: [factory],
      testBaseUrl: 'http://sim-mock:8080',
    });
    await registry.getProvider('hologram');
    expect(factory.create.mock.calls[0]?.[1]).toEqual({ testBaseUrl: 'http://sim-mock:8080' });
  });

  it('refuses a factory registered twice', () => {
    expect(
      () =>
        new SimProviderRegistry({
          readSettings: () => Promise.resolve(settings()),
          factories: [fakeFactory(), fakeFactory()],
        }),
    ).toThrow(/registered twice/);
  });

  it('answers null for a provider with no factory in this process', async () => {
    const registry = new SimProviderRegistry({
      readSettings: () => Promise.resolve(settings({ enabled: true, apiKey: 'key', orgId: '42' })),
      factories: [],
    });
    expect(await registry.getProvider('hologram')).toBeNull();
    expect(await registry.enabledProviders()).toEqual([]);
  });
});

describe('SimProviderError', () => {
  it('carries its kind, cause and retry hint', () => {
    const cause = new Error('socket hang up');
    const err = new SimProviderError('rate_limited', 'Too many requests', {
      cause,
      retryAfterSeconds: 30,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SimProviderError');
    expect(err.kind).toBe('rate_limited');
    expect(err.cause).toBe(cause);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('has no retry hint by default', () => {
    expect(new SimProviderError('auth', 'Invalid API key').retryAfterSeconds).toBeNull();
  });
});
