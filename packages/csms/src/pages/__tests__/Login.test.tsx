// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

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
    api: {
      get: vi
        .fn()
        .mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '', mfaMethods: [] }),
    },
    ApiError,
  };
});

vi.mock('@/lib/auth', () => {
  const state = { login: loginMock, mfaPending: null, isAuthenticated: false };
  class MustResetPasswordError extends Error {}
  return {
    useAuth: (selector: (s: typeof state) => unknown) => selector(state),
    MustResetPasswordError,
  };
});

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({
    companyName: null,
    companyLogo: null,
    portalUrl: null,
    themeColor: null,
  }),
}));

vi.mock('@/components/MfaChallenge', () => ({ MfaChallenge: () => null }));

async function renderLogin(
  path: string,
): Promise<{ loadLanguage: (lang: string) => Promise<void> }> {
  // Fresh i18n setup per test: it reads the saved language when the module loads.
  vi.resetModules();
  const i18nModule = await import('@/i18n/index');
  const { Login } = await import('../Login');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Rendered before the saved language bundle finishes loading.
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    await i18nModule.i18nReady;
  });
  return { loadLanguage: i18nModule.loadLanguage };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Login errors follow the language', () => {
  it('shows an SSO error in the saved language and after a language change', async () => {
    localStorage.setItem('language', 'de');
    const { loadLanguage } = await renderLogin('/login?error=sso_no_email');
    expect(await screen.findByText(de.auth.ssoNoEmail)).toBeTruthy();

    await act(async () => {
      await loadLanguage('es');
    });
    expect(screen.getByText(es.auth.ssoNoEmail)).toBeTruthy();
  });

  it('translates a sign-in error at render', async () => {
    localStorage.setItem('language', 'de');
    loginMock.mockRejectedValueOnce(new Error('network'));
    const { loadLanguage } = await renderLogin('/login');

    fireEvent.change(screen.getByLabelText(de.auth.emailLabel), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(de.auth.passwordLabel), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText(de.auth.emailLabel).closest('form') as HTMLFormElement);
    expect(await screen.findByText(de.auth.invalidCredentials)).toBeTruthy();

    await act(async () => {
      await loadLanguage('es');
    });
    expect(screen.getByText(es.auth.invalidCredentials)).toBeTruthy();
  });
});
