// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { registerMock, getMock, recaptchaMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
  getMock: vi.fn(),
  recaptchaMock: vi.fn(),
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
    api: { get: getMock, post: vi.fn() },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { register: typeof registerMock }) => unknown) =>
    selector({ register: registerMock }),
}));

vi.mock('@/lib/recaptcha', () => ({ executeRecaptcha: recaptchaMock }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'validation.passwordMissing'
        ? `missing: ${String(opts?.['rules'])}`
        : key.startsWith('validation.passwordRule.')
          ? key.slice('validation.passwordRule.'.length)
          : key.startsWith('errors.')
            ? `translated:${key}`
            : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

import { ApiError } from '@/lib/api';
import { Register } from '../Register';

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/register']}>
        <Register />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fill(password: string): void {
  fireEvent.change(screen.getByLabelText('auth.firstName'), { target: { value: 'Jane' } });
  fireEvent.change(screen.getByLabelText('auth.lastName'), { target: { value: 'Doe' } });
  fireEvent.change(screen.getByLabelText('auth.email'), { target: { value: 'jane@example.com' } });
  fireEvent.change(screen.getByLabelText('auth.password'), { target: { value: password } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Register', () => {
  it('shows the password requirements before submit', () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '' });
    renderPage();
    expect(screen.getByTestId('password-requirements')).toBeTruthy();
    expect(screen.getByLabelText('auth.password').getAttribute('aria-describedby')).toBe(
      'password-requirements',
    );
  });

  it('names the missing rules and does not call the API', () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '' });
    renderPage();
    fill('abcdefghijkl');
    fireEvent.click(screen.getByRole('button', { name: 'auth.createAccount' }));
    expect(screen.getByText('missing: uppercase and number')).toBeTruthy();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('explains a WEAK_PASSWORD reply at the password field', async () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '' });
    registerMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD' }));
    renderPage();
    fill('Abcdefghijk1');
    fireEvent.click(screen.getByRole('button', { name: 'auth.createAccount' }));
    expect(await screen.findByText('translated:errors.WEAK_PASSWORD')).toBeTruthy();
  });

  it('sends a reCAPTCHA token when reCAPTCHA is on', async () => {
    getMock.mockResolvedValue({ recaptchaEnabled: true, recaptchaSiteKey: 'site-key' });
    recaptchaMock.mockResolvedValue('captcha-token');
    registerMock.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/security/public');
    });
    // Let the security query settle before submitting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fill('Abcdefghijk1');
    fireEvent.click(screen.getByRole('button', { name: 'auth.createAccount' }));
    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({ recaptchaToken: 'captcha-token', password: 'Abcdefghijk1' }),
      );
    });
    expect(recaptchaMock).toHaveBeenCalledWith('site-key', 'register');
  });
});
