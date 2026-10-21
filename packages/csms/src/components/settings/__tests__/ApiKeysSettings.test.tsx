// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return {
    api: { get: getMock, post: postMock, patch: patchMock, delete: vi.fn() },
    ApiError,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: { permissions: string[] }) => unknown) =>
    select({ permissions: ['stations:read', 'stations:write'] }),
}));

vi.mock('@/components/PermissionEditor', () => ({
  PermissionEditor: ({ onChange }: { onChange: (perms: string[]) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange(['stations:write']);
      }}
    >
      widen
    </button>
  ),
}));

// The proof field has its own tests: this stand-in reports a password proof on click.
vi.mock('@/components/FactorProofField', () => ({
  proofRejection: () => ({ code: null }),
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (proof: { kind: string; password: string } | null) => void;
    showMissing?: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onChange({ kind: 'password', password: 'Secret1!' });
        }}
      >
        prove
      </button>
      {showMissing === true && <p>proof-missing</p>}
    </div>
  ),
}));

import { ApiKeysSettings, widensKeyScope } from '../ApiKeysSettings';

function renderPage(keys: unknown[] = []): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/users/me/mfa') {
      return Promise.resolve({
        mfaEnabled: false,
        mfaMethod: null,
        availableMethods: [],
        factorProofKinds: ['password'],
      });
    }
    return Promise.resolve(keys);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ApiKeysSettings />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('widensKeyScope', () => {
  it('counts write as covering read and a key without a scope as every permission', () => {
    expect(widensKeyScope(['stations:write'], ['stations:read'])).toBe(false);
    expect(widensKeyScope(['stations:read'], ['stations:write'])).toBe(true);
    expect(widensKeyScope(null, ['sites:write'])).toBe(false);
  });
});

describe('ApiKeysSettings fresh proof', () => {
  it('asks for the proof before it creates a key, then sends it', async () => {
    postMock.mockResolvedValue({ id: '1', name: 'Script', rawToken: 'x', expiresAt: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /settings.createApiKey/ }));
    fireEvent.change(screen.getByLabelText('settings.apiKeyName'), {
      target: { value: 'Script' },
    });
    const dialog = screen.getByRole('dialog');
    const submit = dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(submit);
    expect(await screen.findByText('proof-missing')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'prove' }));
    fireEvent.click(submit);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/api-keys',
        expect.objectContaining({ proof: { kind: 'password', password: 'Secret1!' } }),
      );
    });
  });

  it('asks for the proof only when an edit widens the key', async () => {
    patchMock.mockResolvedValue({ success: true });
    renderPage([
      {
        id: '7',
        name: 'Narrow',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        lastUsedAt: null,
        permissions: ['stations:read'],
        tokenSuffix: null,
      },
    ]);
    const edit = await screen.findAllByRole('button', { name: /settings.apiKeyEditPermissions/ });
    fireEvent.click(edit[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'widen' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('proof-missing')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'prove' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/api-keys/7', {
        permissions: ['stations:write'],
        proof: { kind: 'password', password: 'Secret1!' },
      });
    });
  });
});
