// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
  return { useAuth: (selector: (s: typeof state) => unknown) => selector(state) };
});

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('@/components/MfaChallenge', () => ({ MfaChallenge: () => null }));

const EXPIRED = { de: de.auth.sessionExpired, es: es.auth.sessionExpired };

async function renderLogin(): Promise<{ loadLanguage: (lang: string) => Promise<void> }> {
  // Fresh i18n instance per test: it reads the saved language when the module loads.
  vi.resetModules();
  const i18nModule = await import('@/i18n/index');
  const { Login } = await import('../Login');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Rendered before the saved language bundle finishes loading, as on a slow network.
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login?reason=session_expired']}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    await i18nModule.i18nReady;
  });
  return { loadLanguage: i18nModule.loadLanguage };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/login?reason=session_expired');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Login session expired notice', () => {
  it('shows the notice in the saved language and follows a language change', async () => {
    localStorage.setItem('portal_language', 'de');
    const { loadLanguage } = await renderLogin();

    expect(await screen.findByText(EXPIRED.de)).toBeTruthy();
    expect(window.location.search).toBe('');

    await act(async () => {
      await loadLanguage('es');
    });
    expect(screen.getByText(EXPIRED.es)).toBeTruthy();
    expect(screen.queryByText(EXPIRED.de)).toBeNull();
  });

  it('translates a sign-in error at render', async () => {
    localStorage.setItem('portal_language', 'de');
    loginMock.mockRejectedValueOnce(new Error('network'));
    const { loadLanguage } = await renderLogin();

    fireEvent.change(screen.getByLabelText(de.auth.email), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(de.auth.password), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText(de.auth.email).closest('form') as HTMLFormElement);
    expect(await screen.findByText(de.auth.invalidCredentials)).toBeTruthy();

    await act(async () => {
      await loadLanguage('es');
    });
    expect(screen.getByText(es.auth.invalidCredentials)).toBeTruthy();
  });
});
