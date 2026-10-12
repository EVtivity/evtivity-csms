// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { state } = vi.hoisted(() => ({
  state: { login: vi.fn(), setMfaPending: vi.fn(), mfaPending: null, isAuthenticated: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return {
    api: { get: vi.fn().mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '' }) },
    ApiError,
  };
});
vi.mock('@/lib/auth', () => {
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
vi.mock('@/components/MfaChallenge', () => ({ MfaChallenge: () => <p>mfa</p> }));

import { Login } from '../Login';

function Where(): React.JSX.Element {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderLogin(path: string): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  state.isAuthenticated = false;
});

describe('Login return-to', () => {
  it('lands on the deep link once signed in (password and MFA end the same way)', async () => {
    state.isAuthenticated = true;
    renderLogin('/login?returnTo=%2Fai%2Finsights%2Fi1');
    expect((await screen.findByTestId('where')).textContent).toBe('/ai/insights/i1');
  });

  it('keeps the deep link while signed out, for the MFA step and the SSO round trip', () => {
    renderLogin('/login?returnTo=%2Fai%2Finsights%2Fi1');
    expect(sessionStorage.getItem('csms_return_to')).toBe('/ai/insights/i1');
  });

  it('goes home for a returnTo outside the CSMS', async () => {
    state.isAuthenticated = true;
    renderLogin('/login?returnTo=https%3A%2F%2Fevil.example%2F');
    expect((await screen.findByTestId('where')).textContent).toBe('/');
  });
});
