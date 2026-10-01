// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

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
    api: { get: vi.fn().mockResolvedValue({}), post: postMock },
    ApiError,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

import { ApiError } from '@/lib/api';
import { Activate } from '../Activate';

const STRONG = 'Str0ng!Password';

function renderPage(search = '?token=raw-token'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/activate${search}`]}>
        <Activate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function submit(password = STRONG, confirm = password): void {
  fireEvent.change(screen.getByLabelText('auth.newPassword'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('auth.confirmPassword'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'auth.activateSubmit' }));
}

afterEach(() => {
  cleanup();
});

describe('Activate', () => {
  it('shows the invalid-link message when the token is missing', () => {
    renderPage('');
    expect(screen.getByText('auth.invalidActivateLink')).toBeTruthy();
    expect(screen.queryByLabelText('auth.newPassword')).toBeNull();
  });

  it('validates the password locally before calling the API', () => {
    renderPage();
    submit('short', 'different');
    expect(screen.getByText('validation.minLength')).toBeTruthy();
    expect(screen.getByText('auth.passwordsMustMatch')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('posts the token and password, then points the driver to sign in', async () => {
    postMock.mockResolvedValueOnce({ success: true });
    renderPage();
    submit();

    await waitFor(() => {
      expect(screen.getByText('auth.activateSuccess')).toBeTruthy();
    });
    expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/activate', {
      token: 'raw-token',
      password: STRONG,
    });
    expect(screen.getByRole('link', { name: 'auth.backToLogin' }).getAttribute('href')).toBe(
      '/login',
    );
  });

  it('explains an invalid, used, or expired link', async () => {
    postMock.mockRejectedValueOnce(
      new ApiError(400, { error: 'Invalid or expired invitation link', code: 'INVALID_TOKEN' }),
    );
    renderPage();
    submit();

    await waitFor(() => {
      expect(screen.getByText('auth.invalidActivateLink')).toBeTruthy();
    });
    expect(screen.getByText('auth.activateAskOperator')).toBeTruthy();
  });

  it('shows the translated API error for other failures', async () => {
    postMock.mockRejectedValueOnce(
      new ApiError(400, { error: 'Password too weak', code: 'WEAK_PASSWORD' }),
    );
    renderPage();
    submit();

    await waitFor(() => {
      expect(screen.getByText('translated:errors.WEAK_PASSWORD')).toBeTruthy();
    });
  });
});
