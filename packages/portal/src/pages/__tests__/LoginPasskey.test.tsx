// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const {
  getMock,
  postMock,
  completeMfaLogin,
  startAuthenticationMock,
  autofillMock,
  cancelCeremonyMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  completeMfaLogin: vi.fn().mockResolvedValue(undefined),
  startAuthenticationMock: vi.fn(),
  autofillMock: vi.fn(),
  cancelCeremonyMock: vi.fn(),
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
    api: { get: getMock, post: postMock },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: autofillMock,
  startAuthentication: startAuthenticationMock,
  WebAuthnAbortService: { cancelCeremony: cancelCeremonyMock },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      login: vi.fn(),
      mfaPending: null,
      isAuthenticated: false,
      mfaEnrollment: null,
      completeMfaLogin,
    }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('@/components/MfaChallenge', () => ({ MfaChallenge: () => null }));

import { ApiError } from '@/lib/api';
import { Login } from '../Login';

const USER = {
  id: 'drv_1',
  email: 'jane@example.com',
  firstName: null,
  lastName: null,
  language: 'en',
  timezone: 'UTC',
  themePreference: 'light',
};
const OPTIONS = { challenge: 'login-challenge' };
const CREDENTIAL = { id: 'cred-1', type: 'public-key' };

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function renderLogin(passkeyLoginEnabled: boolean): ReturnType<typeof render> {
  getMock.mockResolvedValue({
    recaptchaEnabled: false,
    recaptchaSiteKey: '',
    mfaMethods: [],
    ssoEnabled: false,
    webauthnEnabled: true,
    passkeyLoginEnabled,
  });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  startAuthenticationMock.mockReset();
  autofillMock.mockReset();
  autofillMock.mockResolvedValue(false);
  cancelCeremonyMock.mockReset();
  secure(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Answers the passkey options with `options` and the verify call with `verify`. */
function routePost(
  verify: () => Promise<unknown>,
  options: () => Promise<unknown> = () => Promise.resolve(OPTIONS),
): void {
  postMock.mockImplementation((path: string) =>
    path === '/v1/portal/auth/passkey/options' ? options() : verify(),
  );
}

function verifyCalls(): unknown[][] {
  return postMock.mock.calls.filter((c) => c[0] === '/v1/portal/auth/passkey/verify');
}

function autofillCalls(): unknown[][] {
  return startAuthenticationMock.mock.calls.filter(
    (c) => (c[0] as { useBrowserAutofill: boolean }).useBrowserAutofill,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function closed(): Error {
  return Object.assign(new Error('closed'), { name: 'NotAllowedError' });
}

describe('Login with a passkey', () => {
  it('shows no passkey option while passkey sign-in is off', async () => {
    renderLogin(false);
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/security/public?app=portal');
    });
    expect(screen.queryByRole('button', { name: 'auth.signInWithPasskey' })).toBeNull();
    expect(screen.getByLabelText('auth.email').getAttribute('autocomplete')).toBe('off');
  });

  it('hides the passkey option outside a secure page', async () => {
    secure(false);
    renderLogin(true);
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: 'auth.signInWithPasskey' })).toBeNull();
    expect(autofillMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('sizes the passkey button like the sign-in button', async () => {
    renderLogin(true);
    const passkey = await screen.findByRole('button', { name: 'auth.signInWithPasskey' });
    const signIn = screen.getByRole('button', { name: 'auth.signIn' });
    expect(signIn.className).toContain('h-11');
    expect(passkey.className).toContain('h-11');
  });

  it('signs in with the passkey button, its prompt started inside the click', async () => {
    routePost(() => Promise.resolve({ driver: USER }));
    startAuthenticationMock.mockResolvedValue(CREDENTIAL);
    renderLogin(true);
    const button = await screen.findByRole('button', { name: 'auth.signInWithPasskey' });
    expect(screen.getByLabelText('auth.email').getAttribute('autocomplete')).toBe(
      'username webauthn',
    );
    // The options are fetched before the click.
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/passkey/options', {});
    });
    await settle();
    fireEvent.click(button);
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: OPTIONS,
      useBrowserAutofill: false,
    });
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(USER);
    });
    expect(verifyCalls()).toEqual([['/v1/portal/auth/passkey/verify', { credential: CREDENTIAL }]]);
  });

  it('shows the translated reason for an unknown passkey', async () => {
    routePost(() => Promise.reject(new ApiError(404, { code: 'PASSKEY_NOT_FOUND' })));
    startAuthenticationMock.mockResolvedValue(CREDENTIAL);
    renderLogin(true);
    fireEvent.click(await screen.findByRole('button', { name: 'auth.signInWithPasskey' }));
    const error = await screen.findByText('translated:errors.PASSKEY_NOT_FOUND');
    expect(error.className).toContain('text-destructive');
    expect(error.getAttribute('role')).toBe('alert');
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });

  it('shows a closed passkey prompt as a quiet note in a live region', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    startAuthenticationMock.mockRejectedValue(closed());
    renderLogin(true);
    await screen.findByRole('button', { name: 'auth.signInWithPasskey' });
    // The live region is on the page before the note, so screen readers announce it.
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'auth.signInWithPasskey' }));
    const note = await screen.findByText('passkeys.cancelled');
    expect(note).toBe(region);
    expect(note.className).toContain('text-muted-foreground');
  });

  it('offers passkeys in the email autofill and cancels the prompt on leaving the page', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new Error('not expected')));
    // The autofill prompt waits until the user picks a passkey.
    startAuthenticationMock.mockReturnValue(new Promise(() => undefined));
    const view = renderLogin(true);
    await waitFor(() => {
      expect(startAuthenticationMock).toHaveBeenCalledWith({
        optionsJSON: OPTIONS,
        useBrowserAutofill: true,
      });
    });
    view.unmount();
    expect(cancelCeremonyMock).toHaveBeenCalled();
  });

  it('starts no autofill prompt when the page closes during the options fetch', async () => {
    autofillMock.mockResolvedValue(true);
    let release: (value: unknown) => void = () => undefined;
    const options = new Promise((resolve) => {
      release = resolve;
    });
    routePost(
      () => Promise.reject(new Error('not expected')),
      () => options,
    );
    const view = renderLogin(true);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/passkey/options', {});
    });
    await waitFor(() => {
      expect(autofillMock).toHaveBeenCalled();
    });
    await settle();
    view.unmount();
    release(OPTIONS);
    await settle();
    expect(startAuthenticationMock).not.toHaveBeenCalled();
  });

  it('signs in with a passkey picked from the autofill list', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.resolve({ driver: USER }));
    startAuthenticationMock.mockResolvedValue(CREDENTIAL);
    renderLogin(true);
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(USER);
    });
  });

  it('starts no autofill prompt when the browser cannot offer one', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    renderLogin(true);
    await screen.findByRole('button', { name: 'auth.signInWithPasskey' });
    await waitFor(() => {
      expect(autofillMock).toHaveBeenCalled();
    });
    await settle();
    expect(startAuthenticationMock).not.toHaveBeenCalled();
    expect(verifyCalls()).toHaveLength(0);
  });

  it('logs a failed autofill check and keeps the button', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    autofillMock.mockRejectedValue(new Error('check failed'));
    routePost(() => Promise.reject(new Error('not expected')));
    renderLogin(true);
    expect(await screen.findByRole('button', { name: 'auth.signInWithPasskey' })).toBeTruthy();
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'Passkey autofill check failed, offering the button only',
        expect.any(Error),
      );
    });
    expect(startAuthenticationMock).not.toHaveBeenCalled();
  });

  it('stays quiet when the user dismisses the autofill prompt, then offers it again', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new Error('not expected')));
    startAuthenticationMock
      .mockRejectedValueOnce(closed())
      .mockReturnValue(new Promise(() => undefined));
    renderLogin(true);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(2);
    });
    expect(screen.queryByText('passkeys.cancelled')).toBeNull();
  });

  it('stops restarting an autofill prompt the browser refuses at once, until the email field is focused', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new Error('not expected')));
    // Chromium refuses the autofill request at once when it has no passkey to list.
    startAuthenticationMock.mockRejectedValue(closed());
    renderLogin(true);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(4);
    });
    await settle();
    await settle();
    await settle();
    // The first prompt and three restarts, then autofill waits for the driver.
    expect(autofillCalls()).toHaveLength(4);
    const emailField = document.getElementById('email');
    if (emailField == null) throw new Error('no email field');
    fireEvent.focus(emailField);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(8);
    });
    await settle();
    await settle();
    expect(autofillCalls()).toHaveLength(8);
  });

  it('logs an autofill failure that is not a cancel, shows nothing, and retries a few times', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    autofillMock.mockResolvedValue(true);
    routePost(
      () => Promise.reject(new Error('not expected')),
      () => Promise.reject(new ApiError(429, { code: 'RATE_LIMITED' })),
    );
    renderLogin(true);
    await waitFor(() => {
      expect(
        warn.mock.calls.filter((c) => c[0] === 'Passkey autofill failed, offering it again'),
      ).toHaveLength(4);
    });
    await settle();
    // The first try and three retries, then autofill waits for the button.
    expect(
      warn.mock.calls.filter((c) => c[0] === 'Passkey autofill failed, offering it again'),
    ).toHaveLength(4);
    expect(screen.queryByText('translated:errors.RATE_LIMITED')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(startAuthenticationMock).not.toHaveBeenCalled();
  });

  it('stays quiet when a picked passkey answers an expired challenge, and offers autofill again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new ApiError(400, { code: 'WEBAUTHN_CHALLENGE_EXPIRED' })));
    startAuthenticationMock
      .mockResolvedValueOnce(CREDENTIAL)
      .mockReturnValue(new Promise(() => undefined));
    renderLogin(true);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(2);
    });
    expect(warn).toHaveBeenCalledWith(
      'Passkey autofill failed, offering it again',
      expect.anything(),
    );
    expect(screen.queryByText('translated:errors.WEBAUTHN_CHALLENGE_EXPIRED')).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'auth.signInWithPasskey' }).disabled,
    ).toBe(false);
  });

  it('keeps the button pending when its click cancels a waiting autofill prompt', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new Error('not expected')));
    let abortAutofill: (err: unknown) => void = () => undefined;
    startAuthenticationMock.mockImplementation((opts: { useBrowserAutofill: boolean }) => {
      if (opts.useBrowserAutofill) {
        return new Promise((_resolve, reject) => {
          abortAutofill = reject;
        });
      }
      // Starting the button's prompt cancels the waiting autofill one, as the library does.
      abortAutofill(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return new Promise(() => undefined);
    });
    renderLogin(true);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.signInWithPasskey' }));
    await settle();
    const pending = screen.getByRole<HTMLButtonElement>('button', { name: 'auth.signingIn' });
    expect(pending.disabled).toBe(true);
    // The aborted autofill attempt did not restart autofill under the open button prompt.
    expect(autofillCalls()).toHaveLength(1);
  });

  it('offers autofill again once the button prompt ends', async () => {
    autofillMock.mockResolvedValue(true);
    routePost(() => Promise.reject(new Error('not expected')));
    let abortAutofill: (err: unknown) => void = () => undefined;
    startAuthenticationMock.mockImplementation((opts: { useBrowserAutofill: boolean }) => {
      if (opts.useBrowserAutofill) {
        return new Promise((_resolve, reject) => {
          abortAutofill = reject;
        });
      }
      abortAutofill(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return Promise.reject(closed());
    });
    renderLogin(true);
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.signInWithPasskey' }));
    expect(await screen.findByText('passkeys.cancelled')).toBeTruthy();
    await waitFor(() => {
      expect(autofillCalls()).toHaveLength(2);
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'auth.signInWithPasskey' }).disabled,
    ).toBe(false);
  });
});
