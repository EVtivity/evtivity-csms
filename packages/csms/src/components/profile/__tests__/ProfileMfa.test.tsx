// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, deleteMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  deleteMock: vi.fn(),
  postMock: vi.fn(),
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
  return { api: { get: getMock, delete: deleteMock, post: postMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    // Error keys translate to themselves with a mark, as a loaded locale would.
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en' },
  }),
}));

const { startAuthenticationMock } = vi.hoisted(() => ({ startAuthenticationMock: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startAuthentication: startAuthenticationMock,
}));

vi.mock('../ProfileRecoveryCodes', () => ({ ProfileRecoveryCodes: () => null }));
vi.mock('../RecoveryCodesDisplay', () => ({ RecoveryCodesDisplay: () => null }));
// The form itself is tested on its own: this stand-in shows what the card puts in it and
// sends one confirm with the body the form would send.
vi.mock('@/components/MfaSetupForm', () => ({
  MFA_METHOD_LABELS: { totp: 'profile.mfaMethodTotp' },
  MfaSetupForm: ({
    confirm,
    proofReady = true,
    onProofMissing,
    children,
  }: {
    confirm: (body: { method: string; code: string; challengeId?: string }) => Promise<unknown>;
    proofReady?: boolean;
    onProofMissing?: () => void;
    children?: React.ReactNode;
  }) => (
    <div>
      {children}
      <button
        type="button"
        onClick={() => {
          if (!proofReady) {
            onProofMissing?.();
            return;
          }
          void confirm({ method: 'email', code: '123456', challengeId: '7' });
        }}
      >
        test-confirm
      </button>
    </div>
  ),
}));

import { ApiError } from '@/lib/api';
import { ProfileMfa } from '../ProfileMfa';

afterEach(() => {
  cleanup();
  getMock.mockReset();
  deleteMock.mockReset();
  postMock.mockReset();
});

function renderCard(status: Record<string, unknown>): void {
  getMock.mockResolvedValue({
    mfaEnabled: true,
    mfaMethod: 'totp',
    availableMethods: ['email', 'totp'],
    recoveryCodesRemaining: 10,
    recoveryCodesUsedUp: false,
    ...status,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileMfa />
    </QueryClientProvider>,
  );
}

describe('ProfileMfa', () => {
  it('offers turning MFA off when no policy requires it', async () => {
    renderCard({ requiredByPolicy: false });
    expect(await screen.findByRole('button', { name: 'profile.mfaDisable' })).toBeTruthy();
    expect(screen.queryByText('profile.mfaRequiredByPolicy')).toBeNull();
  });

  it('hides turning MFA off and says why while required MFA covers the role', async () => {
    renderCard({ requiredByPolicy: true });
    expect(await screen.findByText('profile.mfaRequiredByPolicy')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'profile.mfaDisable' })).toBeNull();
    expect(screen.queryByLabelText('profile.currentPassword')).toBeNull();
  });

  async function openDisableDialog(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'profile.mfaDisable' }));
    return screen.findByRole('dialog');
  }

  function confirmDisable(dialog: HTMLElement): void {
    fireEvent.click(within(dialog).getByRole('button', { name: 'profile.mfaDisable' }));
  }

  it('asks for no password to turn MFA off: the proof is a factor or a recovery code', async () => {
    renderCard({ requiredByPolicy: false, lastFactorProofKinds: ['totp', 'recovery_code'] });
    const dialog = await openDisableDialog();
    expect(within(dialog).queryByLabelText('profile.currentPassword')).toBeNull();
    expect(within(dialog).getByLabelText('factorProof.totpLabel')).toBeTruthy();
    // Nothing is sent without a proof: the dialog says what is missing.
    confirmDisable(dialog);
    expect(await within(dialog).findByText('factorProof.confirmFirst')).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('turns MFA off with an authenticator code as the proof', async () => {
    deleteMock.mockResolvedValue({ success: true });
    renderCard({ requiredByPolicy: false, lastFactorProofKinds: ['totp', 'recovery_code'] });
    const dialog = await openDisableDialog();
    fireEvent.change(within(dialog).getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    confirmDisable(dialog);
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/mfa', {
        proof: { kind: 'totp', code: '123456' },
      });
    });
  });

  it('turns MFA off with a recovery code and clears it after a refusal', async () => {
    deleteMock.mockRejectedValueOnce(
      new ApiError(400, { error: 'Invalid verification code', code: 'MFA_CODE_INVALID' }),
    );
    renderCard({ requiredByPolicy: false, lastFactorProofKinds: ['totp', 'recovery_code'] });
    const dialog = await openDisableDialog();
    fireEvent.change(within(dialog).getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'recovery_code' },
    });
    const input = within(dialog).getByLabelText('factorProof.recoveryCodeLabel');
    fireEvent.change(input, { target: { value: ' abcde-fghjk ' } });
    confirmDisable(dialog);
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/mfa', {
        proof: { kind: 'recovery_code', recoveryCode: 'abcde-fghjk' },
      });
    });
    expect(await within(dialog).findByText('translated:errors.MFA_CODE_INVALID')).toBeTruthy();
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText<HTMLInputElement>('factorProof.recoveryCodeLabel').value,
      ).toBe('');
    });
  });

  it('shows the translated refusal when the policy started after the page loaded', async () => {
    deleteMock.mockRejectedValue(
      new ApiError(409, { error: 'MFA is required', code: 'MFA_REQUIRED_BY_POLICY' }),
    );
    renderCard({ requiredByPolicy: false, lastFactorProofKinds: ['totp'] });
    const dialog = await openDisableDialog();
    fireEvent.change(within(dialog).getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    confirmDisable(dialog);
    await waitFor(() => {
      expect(screen.getByText('translated:errors.MFA_REQUIRED_BY_POLICY')).toBeTruthy();
    });
  });

  it('asks for the current password to set up MFA and sends it as the proof', async () => {
    postMock.mockResolvedValue({ success: true, recoveryCodes: [] });
    renderCard({ mfaEnabled: false, mfaMethod: null, factorProofKinds: ['password'] });
    const field = await screen.findByLabelText('profile.currentPassword');
    expect(screen.getByText('profile.mfaSetupPasswordHint')).toBeTruthy();
    // Set Up without the proof says it is missing and sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'test-confirm' }));
    expect(screen.getByText('factorProof.confirmFirst')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'test-confirm' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/users/me/mfa/confirm', {
        method: 'email',
        code: '123456',
        challengeId: '7',
        proof: { kind: 'password', password: 'secret-password' },
      });
    });
  });

  it('treats a passkey-only account as protected and proves it with a passkey to add a method', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    const credential = { id: 'cred', type: 'public-key' };
    startAuthenticationMock.mockResolvedValue(credential);
    postMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/users/me/mfa/factor-proof'
          ? { options: { challenge: 'c' } }
          : { success: true },
      ),
    );
    renderCard({
      mfaEnabled: false,
      mfaMethod: null,
      passkeyCount: 1,
      factorProofKinds: ['passkey'],
    });
    expect(await screen.findByText(/profile\.mfaMethodPasskey/)).toBeTruthy();
    expect(screen.queryByText('profile.mfaDisabled')).toBeNull();
    expect(screen.getByText('profile.mfaAddMethodHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    await screen.findByText('factorProof.passkeyVerified');
    // The field reports the proof after it renders the note.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('button', { name: 'test-confirm' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenLastCalledWith('/v1/users/me/mfa/confirm', {
        method: 'email',
        code: '123456',
        challengeId: '7',
        proof: { kind: 'passkey', credential },
      });
    });
  });

  it('sends no proof for an account without a password or a factor', async () => {
    postMock.mockResolvedValue({ success: true, recoveryCodes: [] });
    renderCard({ mfaEnabled: false, mfaMethod: null, factorProofKinds: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'test-confirm' }));
    expect(screen.queryByLabelText('profile.currentPassword')).toBeNull();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/users/me/mfa/confirm', {
        method: 'email',
        code: '123456',
        challengeId: '7',
      });
    });
  });
});
