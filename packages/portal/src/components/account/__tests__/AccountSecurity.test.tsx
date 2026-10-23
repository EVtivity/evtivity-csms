// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_PASSWORD_POLICY } from '@evtivity/lib/password-policy';

const { getMock, patchMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  postMock: vi.fn(),
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
    api: { get: getMock, patch: patchMock, post: postMock },
    ApiError,
    getApiErrorCode: () => null,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/hooks/use-password-policy', () => ({
  usePasswordPolicy: () => DEFAULT_PASSWORD_POLICY,
  useWeakPasswordReply: () => () => null,
}));

vi.mock('../AccountPasskeys', () => ({ AccountPasskeys: () => null }));
vi.mock('../AccountRecoveryCodes', () => ({ AccountRecoveryCodes: () => null }));

import { AccountSecurity } from '../AccountSecurity';

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
});

function renderPage(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccountSecurity />
    </QueryClientProvider>,
  );
}

describe('AccountSecurity', () => {
  it('shows the MFA load error with a Retry that reads the status again', async () => {
    getMock.mockRejectedValueOnce(new Error('down'));
    renderPage();
    expect(await screen.findByText('profile.mfaLoadError')).toBeTruthy();
    getMock.mockResolvedValue({
      mfaEnabled: false,
      mfaMethod: null,
      availableMethods: ['totp'],
      factorProofKinds: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'errors.retry' }));
    expect(await screen.findByText('profile.mfaSecurity')).toBeTruthy();
    expect(screen.queryByText('profile.mfaLoadError')).toBeNull();
  });

  it('shows a changed password in the success color and clears it on the next edit', async () => {
    getMock.mockResolvedValue({ mfaEnabled: false, availableMethods: [], factorProofKinds: [] });
    patchMock.mockResolvedValue({ success: true });
    renderPage();
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'Old-password-1' },
    });
    fireEvent.change(screen.getByLabelText('profile.newPassword'), {
      target: { value: 'New-password-12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.changePassword' }));
    const done = await screen.findByText('profile.passwordChanged');
    expect(done.className).toContain('text-success');
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'x' },
    });
    expect(screen.queryByText('profile.passwordChanged')).toBeNull();
  });
});
