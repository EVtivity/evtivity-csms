// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const originalEnv = process.env['SETTINGS_ENCRYPTION_KEY'];

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock('drizzle-orm', () => ({
  like: vi.fn((_col, _pattern) => ({ type: 'like' })),
}));

vi.mock('../schema/settings.js', () => ({
  settings: { key: 'key', value: 'value' },
}));

vi.mock('@evtivity/lib', () => ({
  decryptString: vi.fn((val: string) => `decrypted:${val}`),
}));

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('getSsoConfig', () => {
  beforeAll(() => {
    process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env['SETTINGS_ENCRYPTION_KEY'] = originalEnv;
    } else {
      delete process.env['SETTINGS_ENCRYPTION_KEY'];
    }
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns null when sso.enabled is false', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'sso.enabled', value: false }]));
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    const result = await getSsoConfig();
    expect(result).toBeNull();
  });

  it('returns null when sso.enabled is missing', async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    const result = await getSsoConfig();
    expect(result).toBeNull();
  });

  it('returns config object when enabled with valid settings', async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { key: 'sso.enabled', value: true },
        { key: 'sso.provider', value: 'okta' },
        { key: 'sso.entryPoint', value: 'https://idp.example.com/sso' },
        { key: 'sso.issuer', value: 'evtivity-csms' },
        { key: 'sso.certEnc', value: 'encrypted_cert_value' },
        { key: 'sso.autoProvision', value: true },
        { key: 'sso.defaultRoleId', value: 'rol_001' },
        {
          key: 'sso.attributeMapping',
          value: '{"email":"mail","firstName":"givenName","lastName":"sn"}',
        },
      ]),
    );
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    const result = await getSsoConfig();
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(true);
    expect(result?.provider).toBe('okta');
    expect(result?.entryPoint).toBe('https://idp.example.com/sso');
    expect(result?.issuer).toBe('evtivity-csms');
    expect(result?.cert).toBe('decrypted:encrypted_cert_value');
    expect(result?.autoProvision).toBe(true);
    expect(result?.defaultRoleId).toBe('rol_001');
    expect(result?.attributeMapping).toEqual({
      email: 'mail',
      firstName: 'givenName',
      lastName: 'sn',
    });
  });

  it('returns cached value within TTL', async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { key: 'sso.enabled', value: true },
        { key: 'sso.entryPoint', value: 'https://idp.example.com' },
        { key: 'sso.certEnc', value: '' },
      ]),
    );
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    await getSsoConfig();
    await getSsoConfig();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('clearSsoSettingsCache forces re-read', async () => {
    mockSelect.mockReturnValue(makeChain([{ key: 'sso.enabled', value: false }]));
    const { getSsoConfig, clearSsoSettingsCache } = await import('../lib/sso-settings.js');
    await getSsoConfig();
    clearSsoSettingsCache();
    await getSsoConfig();
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('returns null on db error with no prior cache', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('db error');
    });
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    const result = await getSsoConfig();
    expect(result).toBeNull();
  });

  it('handles attributeMapping as object (not string)', async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { key: 'sso.enabled', value: true },
        { key: 'sso.certEnc', value: '' },
        {
          key: 'sso.attributeMapping',
          value: { email: 'userEmail', firstName: 'fn', lastName: 'ln' },
        },
      ]),
    );
    const { getSsoConfig } = await import('../lib/sso-settings.js');
    const result = await getSsoConfig();
    expect(result?.attributeMapping).toEqual({
      email: 'userEmail',
      firstName: 'fn',
      lastName: 'ln',
    });
  });
});
