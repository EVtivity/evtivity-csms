// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ like: vi.fn(() => ({ type: 'like' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));

function rows(result: unknown[] | Error) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

describe('getMobileAppConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('reads both lists and caches them', async () => {
    mockSelect.mockReturnValue(
      rows([
        { key: 'mobile.app.urlSchemes', value: ['evtivity'] },
        { key: 'mobile.app.androidPackageNames', value: ['com.evtivity.driver'] },
      ]),
    );
    const { getMobileAppConfig, clearMobileAppConfigCache } =
      await import('../lib/mobile-app-settings.js');
    const expected = { urlSchemes: ['evtivity'], androidPackageNames: ['com.evtivity.driver'] };
    expect(await getMobileAppConfig()).toEqual(expected);
    expect(await getMobileAppConfig()).toEqual(expected);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    clearMobileAppConfigCache();
    await getMobileAppConfig();
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('treats a missing or invalid stored value as no app', async () => {
    mockSelect.mockReturnValue(rows([{ key: 'mobile.app.urlSchemes', value: ['https'] }]));
    const { getMobileAppConfig } = await import('../lib/mobile-app-settings.js');
    expect(await getMobileAppConfig()).toEqual({ urlSchemes: [], androidPackageNames: [] });
  });

  it('fails closed when the read fails', async () => {
    mockSelect.mockReturnValue(rows(new Error('db down')));
    const { getMobileAppConfig } = await import('../lib/mobile-app-settings.js');
    expect(await getMobileAppConfig()).toEqual({ urlSchemes: [], androidPackageNames: [] });
  });
});
