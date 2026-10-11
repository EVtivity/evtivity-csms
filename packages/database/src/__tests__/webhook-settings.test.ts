// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));

function chainResolving(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

// Under load (a full run) the first import of the module graph can outlast
// the 5 s test timeout. Load it once here with a longer hook timeout; each
// test still imports a fresh copy after vi.resetModules, from the warm cache.
beforeAll(async () => {
  await import('../lib/webhook-settings.js');
}, 30_000);

describe('getWebhookAllowedPrivateHosts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSelect.mockReset();
  });

  it('returns the stored hosts lowercased and caches them for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: ['N8N', 'hooks.internal', 7] }]));
    const { getWebhookAllowedPrivateHosts } = await import('../lib/webhook-settings.js');

    await expect(getWebhookAllowedPrivateHosts()).resolves.toEqual(['n8n', 'hooks.internal']);
    await getWebhookAllowedPrivateHosts();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when the key is missing or not an array', async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    const { getWebhookAllowedPrivateHosts, clearWebhookSettingsCache } =
      await import('../lib/webhook-settings.js');
    await expect(getWebhookAllowedPrivateHosts()).resolves.toEqual([]);

    clearWebhookSettingsCache();
    mockSelect.mockReturnValue(chainResolving([{ value: 'n8n' }]));
    await expect(getWebhookAllowedPrivateHosts()).resolves.toEqual([]);
  });

  it('returns an empty list on a read error with nothing cached', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: ['n8n'] }]));
    const { getWebhookAllowedPrivateHosts, clearWebhookSettingsCache } =
      await import('../lib/webhook-settings.js');
    await getWebhookAllowedPrivateHosts();

    clearWebhookSettingsCache();
    mockSelect.mockReturnValue(chainResolving(new Error('db down')));
    await expect(getWebhookAllowedPrivateHosts()).resolves.toEqual([]);
  });
});
