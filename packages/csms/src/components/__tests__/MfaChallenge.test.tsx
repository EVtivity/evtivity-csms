// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { MfaPendingState } from '@/lib/mfa-pending';

const { postMock, toastMock, completeMfaLogin, setMfaEnrollment, state } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: vi.fn(),
  completeMfaLogin: vi.fn().mockResolvedValue(undefined),
  setMfaEnrollment: vi.fn(),
  state: { mfaPending: null as MfaPendingState | null },
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
  return { api: { post: postMock }, ApiError };
});

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

const { startAuthenticationMock } = vi.hoisted(() => ({ startAuthenticationMock: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startAuthentication: startAuthenticationMock,
}));

/** Passkeys show only on a secure page. */
function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      mfaPending: state.mfaPending,
      completeMfaLogin,
      setMfaEnrollment,
      clearMfaPending: vi.fn(),
    }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['count'] === 'number' ? `${key}:${String(opts['count'])}` : key,
  }),
}));

import { ApiError } from '@/lib/api';
import { MfaChallenge } from '../MfaChallenge';

const USER = {
  id: 'usr_1',
  email: 'a@b.c',
  firstName: null,
  lastName: null,
  language: 'en',
  timezone: 'UTC',
  themePreference: 'light',
};

/** Answers the passkey options and, for the verify call, `verify`. */
function routePost(options: unknown, verify: () => Promise<unknown>): void {
  postMock.mockImplementation((path: string) =>
    path === '/v1/auth/webauthn/options' ? Promise.resolve(options) : verify(),
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pending(over: Partial<MfaPendingState>): MfaPendingState {
  return { mfaRequired: true, mfaMethod: 'totp', mfaToken: 'tok', ...over };
}

beforeEach(() => {
  postMock.mockReset();
  toastMock.mockReset();
  startAuthenticationMock.mockReset();
  secure(false);
});

afterEach(() => {
  cleanup();
});

describe('MfaChallenge', () => {
  it('hands a switched-off only factor to MFA setup instead of signing in', async () => {
    state.mfaPending = pending({ factors: ['totp'] });
    postMock.mockResolvedValue({
      mfaEnrollmentRequired: true,
      enrollmentToken: 'enroll-jwt',
      availableMethods: ['email'],
    });
    render(<MfaChallenge />);
    fireEvent.change(screen.getByLabelText('auth.mfaCodeLabel'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));
    await waitFor(() => {
      expect(setMfaEnrollment).toHaveBeenCalledWith({
        enrollmentToken: 'enroll-jwt',
        availableMethods: ['email'],
      });
    });
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });

  it('offers no recovery code when the factors have none', () => {
    state.mfaPending = pending({ factors: ['totp'] });
    render(<MfaChallenge />);
    expect(screen.queryByText('auth.useRecoveryCode')).toBeNull();
    expect(screen.getByLabelText('auth.mfaCodeLabel')).toBeTruthy();
  });

  it('signs in with a recovery code and says how many are left', async () => {
    state.mfaPending = pending({ factors: ['totp', 'recovery_code'] });
    postMock.mockResolvedValue({ token: 't', user: USER, role: null, recoveryCodesRemaining: 2 });
    render(<MfaChallenge />);

    fireEvent.click(screen.getByText('auth.useRecoveryCode'));
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: ' ABCDE-12345 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));

    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalled();
    });
    expect(postMock).toHaveBeenCalledWith('/v1/auth/mfa/verify', {
      mfaToken: 'tok',
      recoveryCode: 'abcde12345',
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'warning', title: 'auth.recoveryCodesLeft:2' }),
    );
  });

  it('starts with the recovery code when the method is switched off', () => {
    state.mfaPending = pending({
      mfaMethod: 'sms',
      factors: ['recovery_code'],
      mfaMethodDisabled: true,
    });
    render(<MfaChallenge />);
    expect(screen.getByLabelText('auth.recoveryCodeLabel')).toBeTruthy();
    expect(screen.getByText('auth.mfaMethodSwitchedOff')).toBeTruthy();
    expect(screen.queryByText('auth.useVerificationCode')).toBeNull();
    expect(screen.queryByText('auth.mfaResend')).toBeNull();
  });

  it('keeps the button disabled until the recovery code is complete', () => {
    state.mfaPending = pending({ factors: ['recovery_code'], mfaMethodDisabled: true });
    render(<MfaChallenge />);
    const button = screen.getByRole('button', { name: 'auth.mfaVerify' });
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: 'abcde-1234' },
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: 'abcde-12345' },
    });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('shows the recovery code message for a wrong recovery code', async () => {
    state.mfaPending = pending({ factors: ['totp', 'recovery_code'] });
    postMock.mockRejectedValue(new ApiError(400, { code: 'MFA_CODE_INVALID' }));
    render(<MfaChallenge />);
    fireEvent.click(screen.getByText('auth.useRecoveryCode'));
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: 'abcde12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));
    expect(await screen.findByText('auth.recoveryCodeInvalid')).toBeTruthy();
    fireEvent.click(screen.getByText('auth.useVerificationCode'));
    expect(screen.getByLabelText('auth.mfaCodeLabel')).toBeTruthy();
  });

  it('opens a passkey-only account on the passkey and signs in with it', async () => {
    secure(true);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey', 'recovery_code'] });
    const options = { challenge: 'c2', allowCredentials: [] };
    const credential = { id: 'cred', type: 'public-key' };
    startAuthenticationMock.mockResolvedValue(credential);
    routePost(options, () =>
      Promise.resolve({ token: 't', user: USER, role: { id: 'r', name: 'admin' } }),
    );
    render(<MfaChallenge />);
    expect(screen.queryByLabelText('auth.mfaCodeLabel')).toBeNull();
    expect(screen.getByText('auth.passkeySubtitle')).toBeTruthy();
    expect(screen.queryByText('auth.mfaResend')).toBeNull();
    expect(screen.queryByText('auth.useVerificationCode')).toBeNull();
    // The options are fetched before the click, so the click starts the prompt at once.
    expect(postMock).toHaveBeenCalledWith('/v1/auth/webauthn/options', { mfaToken: 'tok' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'auth.usePasskey' }));
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: options });
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(USER, 'admin');
    });
    expect(postMock).toHaveBeenCalledWith('/v1/auth/webauthn/verify', {
      mfaToken: 'tok',
      credential,
    });
  });

  it('offers a passkey next to the code, opens its prompt in the same click, and switches back', async () => {
    secure(true);
    state.mfaPending = pending({ factors: ['totp', 'passkey', 'recovery_code'] });
    routePost({ challenge: 'c' }, () => Promise.resolve({}));
    startAuthenticationMock.mockReturnValue(new Promise(() => undefined));
    render(<MfaChallenge />);
    await settle();
    expect(screen.getByLabelText('auth.mfaCodeLabel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'auth.usePasskey' }));
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(screen.queryByLabelText('auth.mfaCodeLabel')).toBeNull();
    expect(screen.getByText('auth.useRecoveryCode')).toBeTruthy();
    fireEvent.click(screen.getByText('auth.useVerificationCode'));
    expect(screen.getByLabelText('auth.mfaCodeLabel')).toBeTruthy();
  });

  it('hides the passkey outside a secure page', () => {
    secure(false);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey', 'recovery_code'] });
    render(<MfaChallenge />);
    expect(screen.queryByRole('button', { name: 'auth.usePasskey' })).toBeNull();
    expect(screen.getByLabelText('auth.recoveryCodeLabel')).toBeTruthy();
  });

  it('shows a closed passkey prompt as a quiet note', async () => {
    secure(true);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey'] });
    postMock.mockResolvedValue({ challenge: 'c' });
    startAuthenticationMock.mockRejectedValue(
      Object.assign(new Error('closed'), { name: 'NotAllowedError' }),
    );
    render(<MfaChallenge />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.usePasskey' }));
    const note = await screen.findByText('passkeys.cancelled');
    expect(note.className).toContain('text-muted-foreground');
    expect(note.getAttribute('role')).toBe('status');
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });

  it('shows a refused passkey as an error', async () => {
    secure(true);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey'] });
    routePost({ challenge: 'c' }, () =>
      Promise.reject(new ApiError(400, { code: 'WEBAUTHN_VERIFICATION_FAILED' })),
    );
    startAuthenticationMock.mockResolvedValue({ id: 'cred' });
    render(<MfaChallenge />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.usePasskey' }));
    // The test translator has no catalog, so the code falls back to the passkey message.
    const error = await screen.findByText('auth.passkeyFailed');
    expect(error.className).toContain('text-destructive');
    expect(error.getAttribute('role')).toBe('alert');
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });
});
