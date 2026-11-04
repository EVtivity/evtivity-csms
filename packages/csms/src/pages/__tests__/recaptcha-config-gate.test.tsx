// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, loginMock, recaptchaMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  loginMock: vi.fn(),
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
  return { api: { get: getMock, post: postMock }, ApiError };
});

vi.mock('@/lib/auth', () => {
  class MustResetPasswordError extends Error {}
  const state = {
    login: loginMock,
    mfaPending: null,
    setMfaPending: () => undefined,
    mfaEnrollment: null,
    setMfaEnrollment: () => undefined,
    completeMfaLogin: vi.fn(),
    isAuthenticated: false,
  };
  return {
    useAuth: (selector: (s: typeof state) => unknown) => selector(state),
    MustResetPasswordError,
  };
});

vi.mock('@/lib/recaptcha', () => ({ executeRecaptcha: recaptchaMock }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

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

import { ApiError } from '@/lib/api';
import { Login } from '../Login';
import { ForgotPassword } from '../ForgotPassword';

const ENABLED = { recaptchaEnabled: true, recaptchaSiteKey: 'site-key', mfaMethods: [] };

interface FormCase {
  name: string;
  path: string;
  page: () => React.JSX.Element;
  button: string;
  fill: () => void;
  /** The token the form sent, or `null` while it sent nothing. */
  sentToken: () => string | undefined | null;
}

function change(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el == null) throw new Error(`no field ${id}`);
  fireEvent.change(el, { target: { value } });
}

const CASES: FormCase[] = [
  {
    name: 'sign-in',
    path: '/login',
    page: Login,
    button: 'auth.signIn',
    fill: () => {
      change('email', 'admin@example.com');
      change('password', 'secret');
    },
    sentToken: () => {
      const call = loginMock.mock.calls.at(-1);
      return call == null ? null : (call[2] as string | undefined);
    },
  },
  {
    name: 'forgot password',
    path: '/forgot-password',
    page: ForgotPassword,
    button: 'auth.sendResetLink',
    fill: () => {
      change('email', 'admin@example.com');
    },
    sentToken: () => {
      const call = postMock.mock.calls.at(-1);
      return call == null ? null : (call[1] as { recaptchaToken?: string }).recaptchaToken;
    },
  },
];

function renderCase(c: FormCase): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Page = c.page;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[c.path]}>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function submitButton(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(CASES)('reCAPTCHA config on the $name form', (c) => {
  it('keeps submit disabled until the config loads, and a submit before it waits', async () => {
    let answer: (value: unknown) => void = () => undefined;
    getMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    recaptchaMock.mockResolvedValue('tok-early');
    loginMock.mockResolvedValue(undefined);
    postMock.mockResolvedValue({});
    renderCase(c);

    const button = submitButton(c.button);
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('button-pending-spinner')).toBeTruthy();

    c.fill();
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(c.sentToken()).toBeNull();
    expect(recaptchaMock).not.toHaveBeenCalled();

    await act(async () => {
      answer(ENABLED);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(c.sentToken()).toBe('tok-early');
    });
    expect(recaptchaMock).toHaveBeenCalledWith('site-key', 'login');
  });

  it('gets the token at submit time once the config is loaded', async () => {
    getMock.mockResolvedValue(ENABLED);
    recaptchaMock.mockResolvedValue('tok-1');
    loginMock.mockResolvedValue(undefined);
    postMock.mockResolvedValue({});
    renderCase(c);

    await waitFor(() => {
      expect(submitButton(c.button).disabled).toBe(false);
    });
    expect(screen.queryByTestId('button-pending-spinner')).toBeNull();
    expect(recaptchaMock).not.toHaveBeenCalled();

    c.fill();
    fireEvent.click(submitButton(c.button));
    await waitFor(() => {
      expect(c.sentToken()).toBe('tok-1');
    });
    expect(recaptchaMock).toHaveBeenCalledTimes(1);
    expect(recaptchaMock).toHaveBeenCalledWith('site-key', 'login');
  });

  it('sends no token when the config fails, so the API refuses it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getMock.mockRejectedValue(new Error('network'));
    const refused = new ApiError(400, { code: 'RECAPTCHA_REQUIRED' });
    loginMock.mockRejectedValue(refused);
    postMock.mockRejectedValue(refused);
    renderCase(c);

    await waitFor(() => {
      expect(submitButton(c.button).disabled).toBe(false);
    });
    c.fill();
    fireEvent.click(submitButton(c.button));
    await waitFor(() => {
      expect(c.sentToken()).toBeUndefined();
    });
    expect(recaptchaMock).not.toHaveBeenCalled();
    if (c.name === 'sign-in') {
      expect(await screen.findByText('auth.recaptchaFailed')).toBeTruthy();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
