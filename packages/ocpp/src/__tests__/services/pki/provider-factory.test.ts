// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// queryMock returns the settings rows. The factory invokes the mocked client
// in two shapes per call: client(PROVIDER_KEYS) to build the `IN ${...}`
// fragment (first arg is a plain string array), and client`SELECT ...` as a
// tagged template (first arg is a TemplateStringsArray with a `.raw` prop).
// Only the tagged-template invocation should yield rows; the IN-list
// invocation returns an opaque marker.
const queryMock = vi.fn();

function clientImpl(...args: unknown[]): unknown {
  const first = args[0];
  const isTaggedTemplate =
    Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw');
  if (isTaggedTemplate) {
    return queryMock(...args);
  }
  return { inList: first };
}

const decryptStringMock = vi.fn();

vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => clientImpl(...args),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    decryptString: (...args: unknown[]) => decryptStringMock(...args) as string,
  };
});

vi.mock('../../../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!' },
}));

function settingsRow(
  key: string,
  value: string,
  updatedAt: Date | string,
): Record<string, unknown> {
  return { key, value, updated_at: updatedAt };
}

async function loadFactory(): Promise<typeof import('../../../services/pki/provider-factory.js')> {
  // Reset modules so the module-level cachedProvider starts null per test.
  vi.resetModules();
  return import('../../../services/pki/provider-factory.js');
}

beforeEach(() => {
  queryMock.mockReset();
  decryptStringMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPkiProvider', () => {
  it('returns a ManualProvider when pnc.provider is "manual"', async () => {
    queryMock.mockResolvedValueOnce([
      settingsRow('pnc.provider', 'manual', new Date('2026-01-01T00:00:00Z')),
    ]);

    const { getPkiProvider } = await loadFactory();
    const { ManualProvider } = await import('../../../services/pki/manual-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(ManualProvider);

    // The settings query selected the 5 PnC keys.
    const sqlStrings = (queryMock.mock.calls[0] as unknown[])[0] as string[];
    expect(sqlStrings.join('?')).toContain('SELECT key, value, updated_at FROM settings');
  });

  it('defaults to ManualProvider when no pnc.provider row exists', async () => {
    queryMock.mockResolvedValueOnce([]);

    const { getPkiProvider } = await loadFactory();
    const { ManualProvider } = await import('../../../services/pki/manual-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(ManualProvider);
  });

  it('returns a HubjectProvider with a decrypted client secret when pnc.provider is "hubject"', async () => {
    decryptStringMock.mockReturnValue('decrypted-secret');
    queryMock.mockResolvedValueOnce([
      settingsRow('pnc.provider', 'hubject', new Date('2026-01-02T00:00:00Z')),
      settingsRow(
        'pnc.hubject.baseUrl',
        'https://hub.example.com',
        new Date('2026-01-01T00:00:00Z'),
      ),
      settingsRow('pnc.hubject.clientId', 'cid', new Date('2026-01-01T00:00:00Z')),
      settingsRow('pnc.hubject.clientSecretEnc', 'enc-blob', new Date('2026-01-01T00:00:00Z')),
      settingsRow(
        'pnc.hubject.tokenUrl',
        'https://hub.example.com/token',
        new Date('2026-01-01T00:00:00Z'),
      ),
    ]);

    const { getPkiProvider } = await loadFactory();
    const { HubjectProvider } = await import('../../../services/pki/hubject-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(HubjectProvider);

    // Decryption was attempted with the encrypted blob and the configured key.
    expect(decryptStringMock).toHaveBeenCalledWith('enc-blob', 'test-encryption-key-32chars!!!!!');

    // Verify the decrypted secret is actually wired into the provider config by
    // exercising the OAuth path and inspecting the outbound token request body.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ access_token: 't', expires_in: 3600 }),
      text: vi.fn().mockResolvedValue('-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider.getRootCertificates('V2G');

    const tokenInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const params = new URLSearchParams(tokenInit.body as string);
    expect(params.get('client_secret')).toBe('decrypted-secret');
    expect(params.get('client_id')).toBe('cid');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hub.example.com/token');

    vi.unstubAllGlobals();
  });

  it('still builds a HubjectProvider with an empty secret when decryption throws', async () => {
    decryptStringMock.mockImplementation(() => {
      throw new Error('bad key');
    });
    queryMock.mockResolvedValueOnce([
      settingsRow('pnc.provider', 'hubject', new Date('2026-01-02T00:00:00Z')),
      settingsRow('pnc.hubject.clientSecretEnc', 'enc-blob', new Date('2026-01-01T00:00:00Z')),
    ]);

    const { getPkiProvider } = await loadFactory();
    const { HubjectProvider } = await import('../../../services/pki/hubject-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(HubjectProvider);
    expect(decryptStringMock).toHaveBeenCalled();
  });

  it('builds a HubjectProvider with an empty secret when clientSecretEnc is absent (no decrypt attempt)', async () => {
    queryMock.mockResolvedValueOnce([
      settingsRow('pnc.provider', 'hubject', new Date('2026-01-02T00:00:00Z')),
    ]);

    const { getPkiProvider } = await loadFactory();
    const { HubjectProvider } = await import('../../../services/pki/hubject-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(HubjectProvider);
    // No encrypted blob means decryptString is never called.
    expect(decryptStringMock).not.toHaveBeenCalled();
  });

  it('returns the same cached instance when no PnC setting changed', async () => {
    const sameDate = new Date('2026-01-01T00:00:00Z');
    queryMock.mockResolvedValue([settingsRow('pnc.provider', 'manual', sameDate)]);

    const { getPkiProvider } = await loadFactory();

    const first = await getPkiProvider();
    const second = await getPkiProvider();

    expect(second).toBe(first);
    // Two settings queries, but only one instance constructed.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the instance when a setting updated_at advances (secret rotation / baseUrl swap)', async () => {
    queryMock
      .mockResolvedValueOnce([
        settingsRow('pnc.provider', 'manual', new Date('2026-01-01T00:00:00Z')),
      ])
      .mockResolvedValueOnce([
        settingsRow('pnc.provider', 'manual', new Date('2026-02-01T00:00:00Z')),
      ]);

    const { getPkiProvider } = await loadFactory();

    const first = await getPkiProvider();
    const second = await getPkiProvider();

    expect(second).not.toBe(first);
  });

  it('rebuilds the instance when the provider type changes', async () => {
    decryptStringMock.mockReturnValue('s');
    queryMock
      .mockResolvedValueOnce([
        settingsRow('pnc.provider', 'manual', new Date('2026-01-01T00:00:00Z')),
      ])
      .mockResolvedValueOnce([
        settingsRow('pnc.provider', 'hubject', new Date('2026-01-01T00:00:00Z')),
        settingsRow('pnc.hubject.clientSecretEnc', 'enc', new Date('2026-01-01T00:00:00Z')),
      ]);

    const { getPkiProvider } = await loadFactory();
    const { ManualProvider } = await import('../../../services/pki/manual-provider.js');
    const { HubjectProvider } = await import('../../../services/pki/hubject-provider.js');

    const first = await getPkiProvider();
    const second = await getPkiProvider();

    expect(first).toBeInstanceOf(ManualProvider);
    expect(second).toBeInstanceOf(HubjectProvider);
  });

  it('parses string updated_at timestamps for cache comparison', async () => {
    queryMock.mockResolvedValue([settingsRow('pnc.provider', 'manual', '2026-03-01T00:00:00Z')]);

    const { getPkiProvider } = await loadFactory();

    const first = await getPkiProvider();
    const second = await getPkiProvider();

    // Same string timestamp parses to the same ms, so the cache holds.
    expect(second).toBe(first);
  });

  it('coerces a non-string setting value to an empty string in the config map', async () => {
    // A row whose value is not a string (e.g. a JSON object from the driver)
    // must not crash the map build; the factory stores '' for it.
    queryMock.mockResolvedValueOnce([
      { key: 'pnc.provider', value: 'hubject', updated_at: new Date('2026-01-01T00:00:00Z') },
      {
        key: 'pnc.hubject.baseUrl',
        value: { nested: true },
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const { getPkiProvider } = await loadFactory();
    const { HubjectProvider } = await import('../../../services/pki/hubject-provider.js');

    const provider = await getPkiProvider();
    expect(provider).toBeInstanceOf(HubjectProvider);

    // The non-string baseUrl coerced to '' means the EST URL is just the path.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ access_token: 't', expires_in: 3600 }),
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider.getRootCertificates('V2G');

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/.well-known/est/cacerts');
    vi.unstubAllGlobals();
  });
});
