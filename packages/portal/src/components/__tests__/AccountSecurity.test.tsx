// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock, getMock, postMock, deleteMock, status } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
  status: { value: {} },
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
    api: { get: getMock, patch: patchMock, post: postMock, delete: deleteMock },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { ApiError } from '@/lib/api';
import { AccountSecurity } from '../account/AccountSecurity';

function renderSecurity(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AccountSecurity />
    </QueryClientProvider>,
  );
}

function submitPasswordChange(newPassword = 'New-Password-123'): void {
  fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
    target: { value: 'old-password' },
  });
  fireEvent.change(screen.getByLabelText('profile.newPassword'), {
    target: { value: newPassword },
  });
  fireEvent.click(screen.getByRole('button', { name: 'profile.changePassword' }));
}

const NO_MFA = { mfaEnabled: false, mfaMethod: null, availableMethods: [] };

beforeEach(() => {
  status.value = NO_MFA;
  getMock.mockImplementation((path: string) =>
    Promise.resolve(path === '/v1/portal/driver/mfa' ? status.value : []),
  );
});

afterEach(() => {
  cleanup();
  patchMock.mockReset();
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
});

describe('AccountSecurity password change', () => {
  it('shows the translated API error', async () => {
    patchMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'INVALID_PASSWORD' }));
    renderSecurity();
    submitPasswordChange();
    expect(await screen.findByText('translated:errors.INVALID_PASSWORD')).toBeTruthy();
  });

  it('shows the password requirements and names the missing rules before calling the API', () => {
    renderSecurity();
    expect(screen.getByTestId('password-requirements')).toBeTruthy();
    submitPasswordChange('lowercaseonly');
    expect(screen.getByText('validation.passwordMissing')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('explains a WEAK_PASSWORD reply at the field', async () => {
    patchMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD' }));
    renderSecurity();
    submitPasswordChange();
    expect(await screen.findByText('translated:errors.WEAK_PASSWORD')).toBeTruthy();
  });

  it('marks the rules a WEAK_PASSWORD reply names', async () => {
    patchMock.mockRejectedValue(
      new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD', missing: ['symbol'] }),
    );
    renderSecurity();
    submitPasswordChange();
    expect(await screen.findByText('validation.passwordMissing')).toBeTruthy();
    const symbol = screen
      .getByTestId('password-requirements')
      .querySelector<HTMLElement>('[data-rule="symbol"]');
    expect(symbol?.dataset.met).toBe('false');
  });

  it('falls back to the generic text when the request does not reach the API', async () => {
    patchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderSecurity();
    submitPasswordChange();
    expect(await screen.findByText('profile.passwordChangeFailed')).toBeTruthy();
  });
});

describe('AccountSecurity MFA', () => {
  it('sends the password proof with the confirm of a driver without a factor', async () => {
    status.value = {
      ...NO_MFA,
      availableMethods: ['totp'],
      factorProofKinds: ['password'],
    };
    postMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/portal/driver/mfa/setup'
          ? { qrDataUri: 'data:image/png;base64,x', secret: 'S' }
          : { success: true, recoveryCodes: [] },
      ),
    );
    renderSecurity();
    const setUp = await screen.findByRole('button', { name: 'profile.mfaSetUp' });
    // Without the proof, Set Up says so and sends nothing.
    fireEvent.click(setUp);
    expect(await screen.findByText('factorProof.confirmFirst')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByLabelText('profile.currentPassword', { selector: '#mfa-setup-proof-password' }),
      {
        target: { value: 'pw-1' },
      },
    );
    fireEvent.click(setUp);
    await screen.findByAltText('profile.mfaQrCode');
    fireEvent.change(screen.getByLabelText('profile.mfaEnterCode'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaVerify' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenLastCalledWith('/v1/portal/driver/mfa/confirm', {
        method: 'totp',
        code: '123456',
        challengeId: undefined,
        proof: { kind: 'password', password: 'pw-1' },
      });
    });
  });

  it('shows a passkey-only driver as protected, with recovery codes and the passkey list', async () => {
    status.value = {
      ...NO_MFA,
      availableMethods: ['totp'],
      passkeyCount: 1,
      factorProofKinds: ['passkey'],
      recoveryCodesRemaining: 4,
    };
    renderSecurity();
    expect(await screen.findByText('profile.mfaMethodPasskey')).toBeTruthy();
    expect(screen.getByText('profile.mfaAddMethodHint')).toBeTruthy();
    expect(screen.getByTestId('recovery-codes-remaining')).toBeTruthy();
    expect(screen.getByTestId('account-passkeys')).toBeTruthy();
    expect(screen.queryByText('profile.mfaDisabled')).toBeNull();
  });

  it('hides turning MFA off while required MFA covers drivers', async () => {
    status.value = {
      mfaEnabled: true,
      mfaMethod: 'totp',
      availableMethods: ['totp'],
      requiredByPolicy: true,
    };
    renderSecurity();
    expect(await screen.findByText('profile.mfaRequiredByPolicy')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'profile.mfaDisable' })).toBeNull();
  });
});

describe('AccountSecurity turning MFA off', () => {
  const TOTP_ON = {
    mfaEnabled: true,
    mfaMethod: 'totp',
    availableMethods: ['totp'],
    recoveryCodesRemaining: 10,
    lastFactorProofKinds: ['totp', 'recovery_code'],
  };

  async function openDisableDialog(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'profile.mfaDisable' }));
    return screen.findByRole('dialog');
  }

  function confirmDisable(dialog: HTMLElement): void {
    fireEvent.click(within(dialog).getByRole('button', { name: 'profile.mfaDisable' }));
  }

  it('asks for a factor or a recovery code, never the password, and sends nothing without one', async () => {
    status.value = TOTP_ON;
    renderSecurity();
    const dialog = await openDisableDialog();
    expect(within(dialog).queryByLabelText('profile.currentPassword')).toBeNull();
    expect(within(dialog).getByLabelText('factorProof.totpLabel')).toBeTruthy();
    confirmDisable(dialog);
    expect(await within(dialog).findByText('factorProof.confirmFirst')).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('turns MFA off with an authenticator code as the proof', async () => {
    deleteMock.mockResolvedValue({ success: true });
    status.value = TOTP_ON;
    renderSecurity();
    const dialog = await openDisableDialog();
    fireEvent.change(within(dialog).getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    confirmDisable(dialog);
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/portal/driver/mfa', {
        proof: { kind: 'totp', code: '123456' },
      });
    });
  });

  it('turns MFA off with a recovery code and asks again after a refusal', async () => {
    deleteMock.mockRejectedValueOnce(
      new ApiError(400, { error: 'Invalid verification code', code: 'MFA_CODE_INVALID' }),
    );
    status.value = TOTP_ON;
    renderSecurity();
    const dialog = await openDisableDialog();
    fireEvent.change(within(dialog).getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'recovery_code' },
    });
    fireEvent.change(within(dialog).getByLabelText('factorProof.recoveryCodeLabel'), {
      target: { value: 'abcde-fghjk' },
    });
    confirmDisable(dialog);
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/portal/driver/mfa', {
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
});
