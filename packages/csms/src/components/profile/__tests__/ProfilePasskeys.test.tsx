// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  getMock,
  postMock,
  patchMock,
  deleteMock,
  startRegistrationMock,
  startAuthenticationMock,
  supportsMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
  startRegistrationMock: vi.fn(),
  startAuthenticationMock: vi.fn(),
  supportsMock: vi.fn(() => true),
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
    api: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
    ApiError,
  };
});

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: supportsMock,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startRegistration: startRegistrationMock,
  startAuthentication: startAuthenticationMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key.startsWith('errors.')
        ? `translated:${key}`
        : opts != null
          ? `${key}:${JSON.stringify(opts)}`
          : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => `at:${value}`,
}));

vi.mock('../RecoveryCodesDisplay', () => ({
  RecoveryCodesDisplay: ({ codes }: { codes: string[] }) => (
    <p data-testid="recovery-codes">{codes.join(',')}</p>
  ),
}));

import { ApiError } from '@/lib/api';
import { ProfilePasskeys, passkeyTypeKey } from '../ProfilePasskeys';

const SYNCED = {
  id: 1,
  name: 'Laptop',
  deviceType: 'multiDevice',
  backedUp: true,
  transports: ['internal'],
  aaguid: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: '2026-10-02T10:00:00.000Z',
};
const KEY = {
  ...SYNCED,
  id: 2,
  name: 'YubiKey',
  deviceType: 'singleDevice',
  backedUp: false,
  lastUsedAt: null,
};

const BASE_STATUS = {
  mfaEnabled: true,
  mfaMethod: 'totp',
  availableMethods: ['totp'],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  passkeyCount: 2,
  factorProofKinds: ['totp', 'passkey'],
  lastFactorIsPasskey: false,
  lastFactorProofKinds: ['totp', 'passkey', 'password'],
};

/** A passkey-only account with one passkey: removing it is removing the last factor. */
const LAST_FACTOR = {
  mfaEnabled: false,
  mfaMethod: null,
  passkeyCount: 1,
  factorProofKinds: ['passkey'],
  lastFactorIsPasskey: true,
  lastFactorProofKinds: ['passkey', 'password'],
};

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function renderCard(status: Record<string, unknown>, credentials: unknown[]): void {
  getMock.mockImplementation((path: string) =>
    Promise.resolve(path === '/v1/users/me/mfa' ? { ...BASE_STATUS, ...status } : credentials),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProfilePasskeys />
    </QueryClientProvider>,
  );
}

const OPTIONS = { challenge: 'reg', rp: { name: 'EVtivity' } };
const PROOF_OPTIONS = { challenge: 'proof' };
const REGISTRATION = { id: 'new-cred', type: 'public-key' };
const ASSERTION = { id: 'cred-1', type: 'public-key' };

/** Answers the registration options and the passkey proof options; `registration` answers the rest. */
function routePost(registration: () => Promise<unknown>): void {
  postMock.mockImplementation((path: string) => {
    if (path === '/v1/users/me/webauthn/registration-options') return Promise.resolve(OPTIONS);
    if (path === '/v1/users/me/mfa/factor-proof') {
      return Promise.resolve({ options: PROOF_OPTIONS });
    }
    return registration();
  });
}

function registrationCalls(): unknown[][] {
  return postMock.mock.calls.filter((c) => c[0] === '/v1/users/me/webauthn/registration');
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
  startRegistrationMock.mockReset();
  startAuthenticationMock.mockReset();
  supportsMock.mockReturnValue(true);
  secure(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('passkeyTypeKey', () => {
  it('names synced, not backed up and device-bound credentials', () => {
    expect(passkeyTypeKey({ deviceType: 'multiDevice', backedUp: true })).toBe(
      'passkeys.typeSynced',
    );
    expect(passkeyTypeKey({ deviceType: 'multiDevice', backedUp: false })).toBe(
      'passkeys.typeNotBackedUp',
    );
    expect(passkeyTypeKey({ deviceType: 'singleDevice', backedUp: false })).toBe(
      'passkeys.typeDeviceBound',
    );
  });
});

describe('ProfilePasskeys', () => {
  it('lists each credential with its type, creation and last use', async () => {
    renderCard({}, [SYNCED, KEY]);
    const laptop = await screen.findByTestId('passkey-row-1');
    expect(within(laptop).getByText('Laptop')).toBeTruthy();
    expect(within(laptop).getByText('passkeys.typeSynced')).toBeTruthy();
    expect(within(laptop).getByText(`at:${SYNCED.lastUsedAt}`)).toBeTruthy();
    const key = screen.getByTestId('passkey-row-2');
    expect(within(key).getByText('passkeys.typeDeviceBound')).toBeTruthy();
    expect(within(key).getByText('common.never')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'passkeys.add' })).toBeTruthy();
  });

  it('says passkeys need a secure page and hides Add on a plain HTTP page', async () => {
    secure(false);
    renderCard({}, [SYNCED]);
    expect(await screen.findByText('passkeys.needsSecurePage')).toBeTruthy();
    await screen.findByTestId('passkey-row-1');
    expect(screen.queryByRole('button', { name: 'passkeys.add' })).toBeNull();
  });

  it('hides Add when the browser has no passkey support', async () => {
    supportsMock.mockReturnValue(false);
    renderCard({}, []);
    expect(await screen.findByText('passkeys.needsSecurePage')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'passkeys.add' })).toBeNull();
  });

  it('hides Add when the administrator turned passkeys off', async () => {
    renderCard({ webauthnEnabled: false }, []);
    expect(await screen.findByText('passkeys.turnedOff')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'passkeys.add' })).toBeNull();
  });

  it('adds a first passkey with the password proof, then names it and shows the codes', async () => {
    renderCard(
      { mfaEnabled: false, mfaMethod: null, passkeyCount: 0, factorProofKinds: ['password'] },
      [],
    );
    routePost(() =>
      Promise.resolve({
        credential: { ...SYNCED, id: 7, name: 'passkeys.defaultNamePasskey' },
        recoveryCodes: ['a', 'b'],
      }),
    );
    startRegistrationMock.mockResolvedValue(REGISTRATION);
    patchMock.mockResolvedValue({ ...SYNCED, id: 7, name: 'Work Laptop' });

    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    await settle();
    // Continue stays enabled: without the proof it says so and sends nothing.
    const continueButton = screen.getByRole('button', { name: 'passkeys.continue' });
    expect(continueButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(continueButton);
    expect(screen.getByText('factorProof.confirmFirst')).toBeTruthy();
    expect(startRegistrationMock).not.toHaveBeenCalled();
    expect(registrationCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    // The options came before the click, so the browser prompt starts inside it.
    expect(startRegistrationMock).toHaveBeenCalledWith({ optionsJSON: OPTIONS });

    const name = await screen.findByLabelText<HTMLInputElement>('passkeys.nameLabel');
    expect(name.value).toBe('passkeys.defaultNamePasskey');
    expect(registrationCalls()).toEqual([
      [
        '/v1/users/me/webauthn/registration',
        {
          credential: REGISTRATION,
          name: 'passkeys.defaultNamePasskey',
          proof: { kind: 'password', password: 'pw-1' },
        },
      ],
    ]);

    fireEvent.change(name, { target: { value: '  Work Laptop ' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/users/me/webauthn/7', { name: 'Work Laptop' });
    });
    expect((await screen.findByTestId('recovery-codes')).textContent).toBe('a,b');
  });

  it('names a security key as such and saves no rename for the name it already has', async () => {
    renderCard({ factorProofKinds: ['totp'] }, [SYNCED]);
    routePost(() =>
      Promise.resolve({ credential: { ...KEY, name: 'passkeys.defaultNameSecurityKey' } }),
    );
    startRegistrationMock.mockResolvedValue({
      ...REGISTRATION,
      authenticatorAttachment: 'cross-platform',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    fireEvent.change(screen.getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    await screen.findByLabelText('passkeys.nameLabel');
    expect(registrationCalls().at(-1)?.[1]).toMatchObject({
      name: 'passkeys.defaultNameSecurityKey',
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('passkeys.nameLabel')).toBeNull();
    });
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('sends an authenticator code as the proof of an account with TOTP', async () => {
    renderCard({ factorProofKinds: ['totp'] }, [SYNCED]);
    routePost(() => Promise.resolve({ credential: KEY }));
    startRegistrationMock.mockResolvedValue(REGISTRATION);
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    fireEvent.change(screen.getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    await screen.findByLabelText('passkeys.nameLabel');
    expect(registrationCalls().at(-1)).toEqual([
      '/v1/users/me/webauthn/registration',
      {
        credential: REGISTRATION,
        name: 'passkeys.defaultNamePasskey',
        proof: { kind: 'totp', code: '123456' },
      },
    ]);
    // Keep This Name ends the flow without a rename and without codes (not a first factor).
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.keepName' }));
    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recovery-codes')).toBeNull();
  });

  it('adds without a proof for an account that has neither a factor nor a password', async () => {
    renderCard({ mfaEnabled: false, mfaMethod: null, factorProofKinds: [] }, []);
    routePost(() => Promise.resolve({ credential: KEY }));
    startRegistrationMock.mockResolvedValue(REGISTRATION);
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    expect(screen.queryByTestId('factor-proof')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    await screen.findByLabelText('passkeys.nameLabel');
    expect(registrationCalls().at(-1)).toEqual([
      '/v1/users/me/webauthn/registration',
      { credential: REGISTRATION, name: 'passkeys.defaultNamePasskey' },
    ]);
  });

  it('shows a closed browser prompt as a quiet note and keeps the proof', async () => {
    renderCard({ factorProofKinds: ['password'] }, []);
    routePost(() => Promise.reject(new Error('not expected')));
    startRegistrationMock.mockRejectedValue(
      Object.assign(new Error('closed'), { name: 'NotAllowedError' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    const note = await screen.findByText('passkeys.cancelled');
    expect(note.className).toContain('text-muted-foreground');
    expect(note.getAttribute('role')).toBe('status');
    expect(registrationCalls()).toHaveLength(0);
    expect(screen.getByLabelText<HTMLInputElement>('profile.currentPassword').value).toBe('pw-1');
  });

  it('clears a wrong password after a refused registration', async () => {
    renderCard({ factorProofKinds: ['password'] }, []);
    routePost(() => Promise.reject(new ApiError(400, { code: 'INVALID_PASSWORD' })));
    startRegistrationMock.mockResolvedValue(REGISTRATION);
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    const error = await screen.findByText('translated:errors.INVALID_PASSWORD');
    expect(error.getAttribute('role')).toBe('alert');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('profile.currentPassword').value).toBe('');
    });
  });

  it('asks for a fresh authenticator code after any failure once the proof was sent', async () => {
    renderCard({ factorProofKinds: ['totp'] }, [SYNCED]);
    // A network failure is not an API error, but the API may have used the code.
    routePost(() => Promise.reject(new TypeError('Failed to fetch')));
    startRegistrationMock.mockResolvedValue(REGISTRATION);
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    const code = screen.getByLabelText<HTMLInputElement>('factorProof.totpLabel');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    expect(await screen.findByText('passkeys.failed')).toBeTruthy();
    await waitFor(() => {
      expect(code.value).toBe('');
    });
    expect(screen.queryByText('factorProof.confirmFirst')).toBeNull();
  });

  it('shows the limit when the account has the most passkeys allowed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderCard({}, [SYNCED]);
    postMock.mockImplementation((path: string) =>
      path === '/v1/users/me/webauthn/registration-options'
        ? Promise.reject(new ApiError(409, { code: 'PASSKEY_LIMIT_REACHED' }))
        : Promise.resolve({ options: PROOF_OPTIONS }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'passkeys.add' }));
    fireEvent.change(screen.getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'totp' },
    });
    fireEvent.change(screen.getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'passkeys.continue' }));
    expect(await screen.findByText('translated:errors.PASSKEY_LIMIT_REACHED')).toBeTruthy();
    expect(startRegistrationMock).not.toHaveBeenCalled();
  });

  it('renames a credential through the dialog, Enter included', async () => {
    renderCard({}, [SYNCED]);
    patchMock.mockResolvedValue({ ...SYNCED, name: 'Desk' });
    const row = await screen.findByTestId('passkey-row-1');
    fireEvent.click(within(row).getByRole('button', { name: 'passkeys.rename' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('passkeys.nameLabel');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('validation.required');
    expect(patchMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Desk' } });
    // Enter in the field submits the dialog's form.
    const form = input.closest('form');
    expect(form).not.toBeNull();
    if (form != null) fireEvent.submit(form);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/users/me/webauthn/1', { name: 'Desk' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('asks for a proof to remove a credential that is not the last factor', async () => {
    renderCard({}, [SYNCED, KEY]);
    deleteMock.mockResolvedValue({ success: true });
    const row = await screen.findByTestId('passkey-row-2');
    fireEvent.click(within(row).getByRole('button', { name: 'passkeys.remove' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('passkeys.removeLastFactor')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    expect(within(dialog).getByText('factorProof.confirmFirst')).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'password' },
    });
    fireEvent.change(within(dialog).getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/webauthn/2', {
        proof: { kind: 'password', password: 'pw-2' },
      });
    });
  });

  it('follows the server on which passkey is the last factor', async () => {
    // No primary method, but the server says another factor remains.
    renderCard({ ...LAST_FACTOR, lastFactorIsPasskey: false }, [SYNCED]);
    deleteMock.mockResolvedValue({ success: true });
    fireEvent.click(
      within(await screen.findByTestId('passkey-row-1')).getByRole('button', {
        name: 'passkeys.remove',
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('passkeys.removeLastFactor')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'password' },
    });
    fireEvent.change(within(dialog).getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-3' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/webauthn/1', {
        proof: { kind: 'password', password: 'pw-3' },
      });
    });
  });

  it('asks for a proof to remove the last factor, takes the password, and clears a wrong one', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    renderCard(LAST_FACTOR, [SYNCED]);
    deleteMock.mockRejectedValue(new ApiError(400, { code: 'INVALID_PASSWORD' }));
    const row = await screen.findByTestId('passkey-row-1');
    fireEvent.click(within(row).getByRole('button', { name: 'passkeys.remove' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('passkeys.removeLastFactor')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    expect(within(dialog).getByText('factorProof.confirmFirst')).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('factorProof.chooseLabel'), {
      target: { value: 'password' },
    });
    const password = within(dialog).getByLabelText<HTMLInputElement>('profile.currentPassword');
    fireEvent.change(password, { target: { value: 'pw-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/webauthn/1', {
        proof: { kind: 'password', password: 'pw-1' },
      });
    });
    expect(await within(dialog).findByText('translated:errors.INVALID_PASSWORD')).toBeTruthy();
    await waitFor(() => {
      expect(password.value).toBe('');
    });
  });

  it('lets an SSO account without a password remove its only passkey with that passkey', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    startAuthenticationMock.mockResolvedValue(ASSERTION);
    renderCard({ ...LAST_FACTOR, lastFactorProofKinds: ['passkey'] }, [SYNCED]);
    deleteMock.mockResolvedValue({ success: true });
    fireEvent.click(
      within(await screen.findByTestId('passkey-row-1')).getByRole('button', {
        name: 'passkeys.remove',
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('profile.currentPassword')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'factorProof.passkeyButton' }));
    await within(dialog).findByText('factorProof.passkeyVerified');
    // The field reports the proof after it renders the note.
    await settle();
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: PROOF_OPTIONS });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/webauthn/1', {
        proof: { kind: 'passkey', credential: ASSERTION },
      });
    });
  });

  it('shows the policy refusal of a removal that raced a policy change', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    renderCard({ ...LAST_FACTOR, lastFactorProofKinds: ['password'] }, [SYNCED]);
    deleteMock.mockRejectedValue(new ApiError(409, { code: 'MFA_REQUIRED_BY_POLICY' }));
    fireEvent.click(
      within(await screen.findByTestId('passkey-row-1')).getByRole('button', {
        name: 'passkeys.remove',
      }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    expect(
      await within(dialog).findByText('translated:errors.MFA_REQUIRED_BY_POLICY'),
    ).toBeTruthy();
  });

  it('shows the settings outage message when the policy cannot be checked', async () => {
    routePost(() => Promise.reject(new Error('not expected')));
    renderCard({ ...LAST_FACTOR, lastFactorProofKinds: ['password'] }, [SYNCED]);
    deleteMock.mockRejectedValue(new ApiError(503, { code: 'MFA_POLICY_UNAVAILABLE' }));
    fireEvent.click(
      within(await screen.findByTestId('passkey-row-1')).getByRole('button', {
        name: 'passkeys.remove',
      }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'passkeys.remove' }));
    expect(
      await within(dialog).findByText('translated:errors.MFA_POLICY_UNAVAILABLE'),
    ).toBeTruthy();
  });

  it('locks the only passkey while required MFA covers the role', async () => {
    renderCard({ ...LAST_FACTOR, requiredByPolicy: true }, [SYNCED]);
    const row = await screen.findByTestId('passkey-row-1');
    expect(
      within(row).getByRole('button', { name: 'passkeys.remove' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText('passkeys.lastFactorRequired')).toBeTruthy();
  });

  it('mentions passkey sign-in when the administrator allows it', async () => {
    renderCard({ passkeyLoginEnabled: true }, []);
    expect(await screen.findByText('passkeys.descriptionWithSignIn')).toBeTruthy();
    expect(screen.getByText('passkeys.empty')).toBeTruthy();
  });
});
