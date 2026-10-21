// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';

interface EnrollmentAuthState {
  mfaEnrollment: unknown;
  setMfaEnrollment: (state: unknown) => void;
}

const { loginMock, authState } = vi.hoisted(() => {
  const enrollment: EnrollmentAuthState = {
    mfaEnrollment: null,
    setMfaEnrollment: () => undefined,
  };
  return { loginMock: vi.fn(), authState: enrollment };
});

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
    useAuth: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        ...state,
        mfaEnrollment: authState.mfaEnrollment,
        setMfaEnrollment: (v: unknown) => {
          authState.setMfaEnrollment(v);
        },
        setMfaPending: () => undefined,
      }),
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
  authState.mfaEnrollment = null;
  window.history.replaceState(null, '', '/');
});

describe('Login and required MFA', () => {
  it('opens MFA setup when a sign-in requires it', async () => {
    authState.mfaEnrollment = { enrollmentToken: 't', availableMethods: ['totp'] };
    const { Login } = await import('../Login');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/mfa-setup" element={<p>mfa setup page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('mfa setup page')).toBeTruthy();
  });

  it('takes the enrollment token of an SSO sign-in from the fragment and drops it', async () => {
    const received: unknown[] = [];
    authState.setMfaEnrollment = (v) => received.push(v);
    // This tab started the SSO sign-in: it kept the state the fragment brings back.
    sessionStorage.setItem('csms_sso_state', 'tabStateAbcdefghijklmnop');
    window.history.replaceState(
      null,
      '',
      '/login#ssoMfaEnrollmentToken=tok&ssoMfaEnrollmentMethods=email&ssoState=tabStateAbcdefghijklmnop',
    );
    const { Login } = await import('../Login');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/login']}>
          <Login />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(received).toEqual([{ enrollmentToken: 'tok', availableMethods: ['email'] }]);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('csms_sso_state')).toBeNull();
  });

  it('ignores an SSO fragment without the state this tab kept (security review Info 3)', async () => {
    const received: unknown[] = [];
    authState.setMfaEnrollment = (v) => received.push(v);
    for (const [kept, hash] of [
      [null, '#ssoMfaEnrollmentToken=attacker&ssoMfaEnrollmentMethods=email'],
      [
        'tabStateAbcdefghijklmnop',
        '#ssoMfaEnrollmentToken=attacker&ssoState=otherStateAbcdefghijk',
      ],
      [null, '#ssoMfaToken=attacker&ssoMfaMethod=totp&ssoState=otherStateAbcdefghijk'],
    ] as const) {
      cleanup();
      if (kept != null) sessionStorage.setItem('csms_sso_state', kept);
      window.history.replaceState(null, '', `/login${hash}`);
      const { Login } = await import('../Login');
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/login']}>
            <Login />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(window.location.hash).toBe('');
    }
    expect(received).toEqual([]);
    expect(screen.queryByText('mfa setup page')).toBeNull();
  });
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

  it('shows the SSO refusals for a disallowed domain and required MFA without a method', async () => {
    localStorage.setItem('language', 'de');
    await renderLogin('/login?error=sso_domain_not_allowed');
    expect(await screen.findByText(de.auth.ssoDomainNotAllowed)).toBeTruthy();
    cleanup();
    await renderLogin('/login?error=sso_mfa_setup_unavailable');
    expect(await screen.findByText(de.errors.MFA_SETUP_UNAVAILABLE)).toBeTruthy();
  });

  it('says why a password sign-in is refused when required MFA has no method', async () => {
    localStorage.setItem('language', 'de');
    await renderLogin('/login');
    const { ApiError } = await import('@/lib/api');
    loginMock.mockRejectedValueOnce(
      new ApiError(403, { error: 'Required MFA', code: 'MFA_SETUP_UNAVAILABLE' }),
    );
    fireEvent.change(screen.getByLabelText(de.auth.emailLabel), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(de.auth.passwordLabel), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText(de.auth.emailLabel).closest('form') as HTMLFormElement);
    expect(await screen.findByText(de.errors.MFA_SETUP_UNAVAILABLE)).toBeTruthy();
  });

  it('says an SSO reply did not match a sign-in started in this browser', async () => {
    localStorage.setItem('language', 'de');
    await renderLogin('/login?error=sso_session_mismatch');
    expect(await screen.findByText(de.auth.ssoSessionMismatch)).toBeTruthy();
  });

  it('says the MFA settings could not be checked, for a password and an SSO sign-in', async () => {
    localStorage.setItem('language', 'de');
    await renderLogin('/login?error=sso_mfa_policy_unavailable');
    expect(await screen.findByText(de.errors.MFA_POLICY_UNAVAILABLE)).toBeTruthy();
    cleanup();
    await renderLogin('/login');
    const { ApiError } = await import('@/lib/api');
    loginMock.mockRejectedValueOnce(
      new ApiError(503, { error: 'Unavailable', code: 'MFA_POLICY_UNAVAILABLE' }),
    );
    fireEvent.change(screen.getByLabelText(de.auth.emailLabel), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(de.auth.passwordLabel), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText(de.auth.emailLabel).closest('form') as HTMLFormElement);
    expect(await screen.findByText(de.errors.MFA_POLICY_UNAVAILABLE)).toBeTruthy();
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
