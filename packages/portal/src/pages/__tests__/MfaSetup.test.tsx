// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MfaEnrollmentState } from '@/lib/mfa-enrollment';

const { enrollmentPost, completeMfaLogin, clearMfaEnrollment, state } = vi.hoisted(() => ({
  enrollmentPost: vi.fn(),
  completeMfaLogin: vi.fn().mockResolvedValue(undefined),
  clearMfaEnrollment: vi.fn(),
  state: { mfaEnrollment: null as MfaEnrollmentState | null },
}));

vi.mock('@/lib/mfa-enrollment', () => ({ enrollmentPost }));

const { startRegistrationMock } = vi.hoisted(() => ({ startRegistrationMock: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startRegistration: startRegistrationMock,
}));

/** Passkeys show only on a secure page. */
function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: vi.fn().mockResolvedValue({}) }, ApiError };
});

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      mfaEnrollment: state.mfaEnrollment,
      clearMfaEnrollment,
      completeMfaLogin,
      driver: null,
    }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { ApiError } from '@/lib/api';
import { MfaSetup } from '../MfaSetup';

const USER = {
  id: 'drv_1',
  email: 'jane@example.com',
  firstName: null,
  lastName: null,
  language: 'en',
  timezone: 'UTC',
  themePreference: 'light',
};

function renderPage(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/mfa-setup']}>
        <Routes>
          <Route path="/mfa-setup" element={<MfaSetup />} />
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/" element={<p>dashboard</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  enrollmentPost.mockReset();
  startRegistrationMock.mockReset();
  secure(false);
  state.mfaEnrollment = {
    enrollmentToken: 'enroll-jwt',
    availableMethods: ['email', 'totp'],
    webauthnAvailable: false,
  };
});

afterEach(() => {
  cleanup();
});

describe('MfaSetup', () => {
  it('sends a visitor without an enrollment token to sign in', () => {
    state.mfaEnrollment = null;
    renderPage();
    expect(screen.getByText('login page')).toBeTruthy();
  });

  it('offers only the methods the sign-in allowed', () => {
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['totp'],
      webauthnAvailable: false,
    };
    renderPage();
    const options = screen.getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'totp']);
  });

  it('sets up with the enrollment token, shows the recovery codes once, then signs in', async () => {
    enrollmentPost
      .mockResolvedValueOnce({ qrDataUri: 'data:image/png;base64,x', secret: 'SECRET' })
      .mockResolvedValueOnce({
        success: true,
        recoveryCodes: ['abcde-fghjk'],
        driver: USER,
      });
    renderPage();
    fireEvent.change(screen.getByLabelText('profile.mfaSelectMethod'), {
      target: { value: 'totp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    await screen.findByAltText('profile.mfaQrCode');
    expect(enrollmentPost).toHaveBeenCalledWith('/v1/portal/driver/mfa/setup', 'enroll-jwt', {
      method: 'totp',
    });

    fireEvent.change(screen.getByLabelText('profile.mfaEnterCode'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaVerify' }));
    await screen.findByText('abcde-fghjk');
    expect(enrollmentPost).toHaveBeenLastCalledWith('/v1/portal/driver/mfa/confirm', 'enroll-jwt', {
      method: 'totp',
      code: '123456',
    });
    expect(completeMfaLogin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesDone' }));
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(USER);
    });
    expect(clearMfaEnrollment).toHaveBeenCalled();
    expect(await screen.findByText('dashboard')).toBeTruthy();
  });

  it('asks to sign in again when the token is refused', async () => {
    enrollmentPost.mockRejectedValueOnce(new ApiError(401, { code: 'UNAUTHORIZED' }));
    renderPage();
    fireEvent.change(screen.getByLabelText('profile.mfaSelectMethod'), {
      target: { value: 'email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    expect(await screen.findByText('auth.mfaSetupExpired')).toBeTruthy();
  });

  it('enrolls a passkey with the enrollment token and signs in after the codes', async () => {
    secure(true);
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['totp'],
      webauthnAvailable: true,
    };
    const options = { challenge: 'reg' };
    const credential = { id: 'new-cred', type: 'public-key' };
    startRegistrationMock.mockResolvedValue(credential);
    enrollmentPost.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/portal/driver/webauthn/registration-options'
          ? options
          : {
              credential: { id: 1, name: 'passkeys.defaultNamePasskey' },
              recoveryCodes: ['abcde-fghjk'],
              driver: USER,
            },
      ),
    );
    renderPage();
    // The code methods stay available next to the passkey.
    expect(screen.getByLabelText('profile.mfaSelectMethod')).toBeTruthy();
    // The options are fetched before the click, so the click starts the prompt at once.
    await waitFor(() => {
      expect(enrollmentPost).toHaveBeenCalledWith(
        '/v1/portal/driver/webauthn/registration-options',
        'enroll-jwt',
        {},
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaSetupUsePasskey' }));
    expect(startRegistrationMock).toHaveBeenCalledWith({ optionsJSON: options });
    await screen.findByText('abcde-fghjk');
    expect(enrollmentPost).toHaveBeenCalledWith(
      '/v1/portal/driver/webauthn/registration',
      'enroll-jwt',
      {
        credential,
        name: 'passkeys.defaultNamePasskey',
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesDone' }));
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(USER);
    });
  });

  it('offers a passkey alone when no code method can be set up', () => {
    secure(true);
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: [],
      webauthnAvailable: true,
    };
    renderPage();
    expect(screen.getByRole('button', { name: 'auth.mfaSetupUsePasskey' })).toBeTruthy();
    expect(screen.queryByLabelText('profile.mfaSelectMethod')).toBeNull();
    expect(screen.queryByText('profile.mfaNotAvailable')).toBeNull();
  });

  it('hides the passkey outside a secure page or when passkeys are off', () => {
    secure(false);
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['totp'],
      webauthnAvailable: true,
    };
    renderPage();
    expect(screen.queryByRole('button', { name: 'auth.mfaSetupUsePasskey' })).toBeNull();
    cleanup();
    secure(true);
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['totp'],
      webauthnAvailable: false,
    };
    renderPage();
    expect(screen.queryByRole('button', { name: 'auth.mfaSetupUsePasskey' })).toBeNull();
  });

  it('shows a closed passkey prompt as a quiet note', async () => {
    secure(true);
    state.mfaEnrollment = {
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['totp'],
      webauthnAvailable: true,
    };
    enrollmentPost.mockResolvedValue({ challenge: 'reg' });
    startRegistrationMock.mockRejectedValue(
      Object.assign(new Error('closed'), { name: 'NotAllowedError' }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaSetupUsePasskey' }));
    const note = await screen.findByText('passkeys.cancelled');
    expect(note.getAttribute('role')).toBe('status');
    expect(
      enrollmentPost.mock.calls.filter((c) => c[0] === '/v1/portal/driver/webauthn/registration'),
    ).toHaveLength(0);
  });
});
