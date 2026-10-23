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

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null }),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

const { startAuthenticationMock, supportsMock, clearMfaPending } = vi.hoisted(() => ({
  startAuthenticationMock: vi.fn(),
  supportsMock: vi.fn(() => true),
  clearMfaPending: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: supportsMock,
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
      clearMfaPending,
      setMfaEnrollment,
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

const DRIVER = { id: 'drv_1', firstName: 'A', lastName: 'B', language: 'en' };

function pending(over: Partial<MfaPendingState>): MfaPendingState {
  return { mfaRequired: true, mfaMethod: 'email', mfaToken: 'tok', challengeId: '7', ...over };
}

/** Answers the passkey options and, for the verify call, `verify`. */
function routePost(options: unknown, verify: () => Promise<unknown>): void {
  postMock.mockImplementation((path: string) =>
    path === '/v1/portal/auth/webauthn/options' ? Promise.resolve(options) : verify(),
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  postMock.mockReset();
  toastMock.mockReset();
  startAuthenticationMock.mockReset();
  supportsMock.mockReturnValue(true);
  clearMfaPending.mockReset();
  secure(false);
});

afterEach(() => {
  cleanup();
});

describe('portal MfaChallenge', () => {
  it('keeps the code form alone when no recovery code is offered', () => {
    state.mfaPending = pending({});
    render(<MfaChallenge />);
    expect(screen.queryByText('auth.useRecoveryCode')).toBeNull();
    expect(screen.getByText('auth.mfaResend')).toBeTruthy();
  });

  it('signs in with a recovery code and says how many are left', async () => {
    state.mfaPending = pending({ factors: ['email', 'recovery_code'] });
    postMock.mockResolvedValue({ driver: DRIVER, recoveryCodesRemaining: 7 });
    render(<MfaChallenge />);

    fireEvent.click(screen.getByText('auth.useRecoveryCode'));
    expect(screen.queryByText('auth.mfaResend')).toBeNull();
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: 'ABCDE-12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));

    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalled();
    });
    expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/mfa/verify', {
      mfaToken: 'tok',
      recoveryCode: 'abcde12345',
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'info', title: 'auth.recoveryCodesLeft:7' }),
    );
  });

  it('stores the enrollment reply instead of signing in when the method was the only factor', async () => {
    state.mfaPending = pending({ factors: ['email'] });
    postMock.mockResolvedValue({
      mfaEnrollmentRequired: true,
      enrollmentToken: 'enroll-tok',
      availableMethods: ['totp'],
      webauthnAvailable: true,
    });
    render(<MfaChallenge />);
    fireEvent.change(screen.getByLabelText('auth.mfaCodeLabel'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));

    await waitFor(() => {
      expect(setMfaEnrollment).toHaveBeenCalledWith({
        enrollmentToken: 'enroll-tok',
        availableMethods: ['totp'],
        webauthnAvailable: true,
      });
    });
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });

  it('starts with the recovery code when the method is switched off', () => {
    state.mfaPending = pending({ factors: ['recovery_code'], mfaMethodDisabled: true });
    render(<MfaChallenge />);
    expect(screen.getByLabelText('auth.recoveryCodeLabel')).toBeTruthy();
    expect(screen.getByText('auth.mfaMethodSwitchedOff')).toBeTruthy();
    expect(screen.queryByText('auth.useVerificationCode')).toBeNull();
  });

  it('keeps Verify enabled and explains an incomplete recovery code on submit', () => {
    state.mfaPending = pending({ factors: ['recovery_code'], mfaMethodDisabled: true });
    render(<MfaChallenge />);
    const button = screen.getByRole('button', { name: 'auth.mfaVerify' });
    const input = screen.getByLabelText('auth.recoveryCodeLabel');
    fireEvent.change(input, { target: { value: 'abcde-1234' } });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('auth.recoveryCodeIncomplete')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByText('auth.recoveryCodeIncomplete')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'abcde-12345' } });
    expect(screen.queryByText('auth.recoveryCodeIncomplete')).toBeNull();
  });

  it('keeps Verify enabled and explains an incomplete six-digit code on submit', () => {
    state.mfaPending = pending({ factors: ['email'] });
    render(<MfaChallenge />);
    const button = screen.getByRole('button', { name: 'auth.mfaVerify' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('profile.mfaEnterCode')).toBeNull();
    fireEvent.change(screen.getByLabelText('auth.mfaCodeLabel'), { target: { value: '123' } });
    fireEvent.click(button);
    expect(screen.getByText('profile.mfaEnterCode')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('shows the recovery code message for a wrong recovery code', async () => {
    state.mfaPending = pending({ factors: ['recovery_code'], mfaMethodDisabled: true });
    postMock.mockRejectedValue(new ApiError(400, { code: 'MFA_CODE_INVALID' }));
    render(<MfaChallenge />);
    fireEvent.change(screen.getByLabelText('auth.recoveryCodeLabel'), {
      target: { value: 'abcde12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify' }));
    expect(await screen.findByText('auth.recoveryCodeInvalid')).toBeTruthy();
  });

  it('opens a passkey-only driver on the passkey and signs in with it', async () => {
    secure(true);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey', 'recovery_code'] });
    const options = { challenge: 'c2', allowCredentials: [] };
    const credential = { id: 'cred', type: 'public-key' };
    startAuthenticationMock.mockResolvedValue(credential);
    routePost(options, () => Promise.resolve({ driver: DRIVER }));
    render(<MfaChallenge />);
    expect(screen.queryByLabelText('auth.mfaCodeLabel')).toBeNull();
    expect(screen.getByText('auth.passkeySubtitle')).toBeTruthy();
    expect(screen.queryByText('auth.mfaResend')).toBeNull();
    expect(screen.queryByText('auth.useVerificationCode')).toBeNull();
    // The options are fetched before the click, so the click starts the prompt at once.
    expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/webauthn/options', { mfaToken: 'tok' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'auth.usePasskey' }));
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: options });
    await waitFor(() => {
      expect(completeMfaLogin).toHaveBeenCalledWith(DRIVER);
    });
    expect(postMock).toHaveBeenCalledWith('/v1/portal/auth/webauthn/verify', {
      mfaToken: 'tok',
      credential,
    });
  });

  it('offers a passkey next to the code, opens its prompt in the same click, and switches back', async () => {
    secure(true);
    state.mfaPending = pending({
      mfaMethod: 'totp',
      factors: ['totp', 'passkey', 'recovery_code'],
    });
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

  it('says why the passkey is missing outside a secure page and offers the recovery code', () => {
    secure(false);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey', 'recovery_code'] });
    render(<MfaChallenge />);
    expect(screen.queryByRole('button', { name: 'auth.usePasskey' })).toBeNull();
    expect(screen.getByTestId('passkey-unavailable').textContent).toBe(
      'passkeyUnavailable.insecure.signInRecovery',
    );
    expect(screen.getByLabelText('auth.recoveryCodeLabel')).toBeTruthy();
  });

  it('says why the passkey is missing next to the code method', () => {
    secure(false);
    state.mfaPending = pending({ mfaMethod: 'totp', factors: ['totp', 'passkey'] });
    render(<MfaChallenge />);
    expect(screen.getByTestId('passkey-unavailable').textContent).toBe(
      'passkeyUnavailable.insecure.signInCode',
    );
    expect(screen.getByLabelText('auth.mfaCodeLabel')).toBeTruthy();
  });

  it('shows no input a passkey-only account cannot use outside a secure page', () => {
    secure(false);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey'] });
    render(<MfaChallenge />);
    expect(screen.getByTestId('passkey-unavailable').textContent).toBe(
      'passkeyUnavailable.insecure.signInOnly',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'auth.mfaVerify' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'auth.usePasskey' })).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'auth.backToLogin' }));
    expect(clearMfaPending).toHaveBeenCalled();
  });

  it('names a browser without passkeys on a secure page', () => {
    secure(true);
    supportsMock.mockReturnValue(false);
    state.mfaPending = pending({ mfaMethod: 'passkey', factors: ['passkey'] });
    render(<MfaChallenge />);
    expect(screen.getByTestId('passkey-unavailable').textContent).toBe(
      'passkeyUnavailable.unsupported.signInOnly',
    );
  });

  it('shows no passkey note when the page can use passkeys', () => {
    secure(true);
    state.mfaPending = pending({ mfaMethod: 'totp', factors: ['totp', 'passkey'] });
    render(<MfaChallenge />);
    expect(screen.queryByTestId('passkey-unavailable')).toBeNull();
  });

  it('uses the standard sign-in heading', () => {
    state.mfaPending = pending({ factors: ['totp'] });
    render(<MfaChallenge />);
    expect(screen.getByRole('heading', { level: 2, name: 'auth.mfaTitle' })).toBeTruthy();
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
    const error = await screen.findByText('auth.passkeyFailed');
    expect(error.getAttribute('role')).toBe('alert');
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });
});
