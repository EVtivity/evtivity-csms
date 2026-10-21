// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, getMock, startAuthenticationMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  startAuthenticationMock: vi.fn(),
}));
const EMAIL = 'ops@example.com';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startAuthentication: startAuthenticationMock,
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
  return { api: { post: postMock, get: getMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['count'] === 'number'
        ? `${key}:${String(opts['count'])}`
        : opts != null
          ? `${key}:${JSON.stringify(opts)}`
          : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: { user: { email: string } }) => unknown) =>
    select({ user: { email: EMAIL } }),
}));

import { ApiError } from '@/lib/api';
import { ProfileRecoveryCodes } from '../ProfileRecoveryCodes';
import { RecoveryCodesDisplay } from '../RecoveryCodesDisplay';

const CODES = Array.from({ length: 10 }, (_, i) => `abcde-1234${String(i)}`);

function renderCard(method: string, onCodes = vi.fn(), remaining = 3): ReturnType<typeof vi.fn> {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileRecoveryCodes method={method} remaining={remaining} onCodes={onCodes} />
    </QueryClientProvider>,
  );
  return onCodes;
}

function confirmRegenerate(): void {
  fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
}

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  getMock.mockResolvedValue({});
  startAuthenticationMock.mockReset();
  secure(false);
});

afterEach(() => {
  cleanup();
});

describe('ProfileRecoveryCodes', () => {
  it('tells an account that used every code to generate new ones', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProfileRecoveryCodes method="totp" remaining={0} usedUp onCodes={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('recovery-codes-remaining').textContent).toBe(
      'profile.recoveryCodesUsedUp',
    );
  });

  it('keeps the zero state for an account that never had codes', () => {
    renderCard('totp', vi.fn(), 0);
    expect(screen.getByTestId('recovery-codes-remaining').textContent).toBe(
      'profile.recoveryCodesNone',
    );
  });

  it('shows how many codes are left', () => {
    renderCard('totp');
    expect(screen.getByTestId('recovery-codes-remaining').textContent).toBe(
      'profile.recoveryCodesRemaining:3',
    );
  });

  it('offers to generate codes for an account that has none, without a confirmation', () => {
    renderCard('totp', vi.fn(), 0);
    expect(screen.getByTestId('recovery-codes-remaining').textContent).toBe(
      'profile.recoveryCodesNone',
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('factorProof.totpLabel')).toBeTruthy();
  });

  it('regenerates with an authenticator code', async () => {
    postMock.mockResolvedValue({ recoveryCodes: CODES });
    const onCodes = renderCard('totp');
    confirmRegenerate();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('factorProof.totpLabel'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    await waitFor(() => {
      expect(onCodes).toHaveBeenCalledWith(CODES);
    });
    expect(postMock).toHaveBeenCalledWith('/v1/users/me/mfa/recovery-codes', { code: '123456' });
  });

  it('stays clickable without a proof, says so and sends nothing', () => {
    const onCodes = renderCard('totp');
    confirmRegenerate();
    const submit = screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    expect(screen.getByText('factorProof.confirmFirst')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    expect(onCodes).not.toHaveBeenCalled();
  });

  it('keeps the emailed code after a wrong one, so the next try needs no new email', async () => {
    postMock.mockImplementation((_path: string, body: Record<string, unknown>) =>
      body['code'] == null
        ? Promise.resolve({ challengeId: 42 })
        : body['code'] === '111111'
          ? Promise.reject(new ApiError(400, { code: 'MFA_CODE_INVALID' }))
          : Promise.resolve({ recoveryCodes: CODES }),
    );
    const onCodes = renderCard('email');
    confirmRegenerate();
    const input = await screen.findByLabelText<HTMLInputElement>('factorProof.codeLabel');
    await screen.findByText('factorProof.codeSentEmail');
    fireEvent.change(input, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    expect(await screen.findByText('profile.mfaVerifyFailed')).toBeTruthy();
    await waitFor(() => {
      expect(input.value).toBe('');
    });
    fireEvent.change(input, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    await waitFor(() => {
      expect(onCodes).toHaveBeenCalledWith(CODES);
    });
    expect(
      postMock.mock.calls.filter((c) => (c[1] as { code?: string }).code == null),
    ).toHaveLength(1);
    expect(postMock).toHaveBeenLastCalledWith('/v1/users/me/mfa/recovery-codes', {
      code: '654321',
      challengeId: 42,
    });
  });

  it('sends an email code first, then regenerates with it', async () => {
    postMock.mockResolvedValueOnce({ challengeId: 42 }).mockResolvedValueOnce({
      recoveryCodes: CODES,
    });
    const onCodes = renderCard('email');
    confirmRegenerate();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/users/me/mfa/recovery-codes', {});
    });
    fireEvent.change(await screen.findByLabelText('factorProof.codeLabel'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    await waitFor(() => {
      expect(onCodes).toHaveBeenCalledWith(CODES);
    });
    expect(postMock).toHaveBeenLastCalledWith('/v1/users/me/mfa/recovery-codes', {
      code: '654321',
      challengeId: 42,
    });
  });

  it('regenerates with a passkey, the only proof of a passkey-only account', async () => {
    secure(true);
    const credential = { id: 'cred-1', type: 'public-key' };
    startAuthenticationMock.mockResolvedValue(credential);
    postMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/users/me/mfa/recovery-codes/webauthn-options'
          ? { challenge: 'c1', allowCredentials: [] }
          : { recoveryCodes: CODES },
      ),
    );
    const onCodes = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProfileRecoveryCodes method="" remaining={3} passkeyCount={1} onCodes={onCodes} />
      </QueryClientProvider>,
    );
    confirmRegenerate();
    expect(screen.queryByLabelText('factorProof.codeLabel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    await screen.findByText('factorProof.passkeyVerified');
    expect(postMock).toHaveBeenCalledWith('/v1/users/me/mfa/recovery-codes/webauthn-options', {});
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'c1', allowCredentials: [] },
    });
    // The field reports the proof after it renders the note.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    await waitFor(() => {
      expect(onCodes).toHaveBeenCalledWith(CODES);
    });
    expect(postMock).toHaveBeenLastCalledWith('/v1/users/me/mfa/recovery-codes', { credential });
  });

  it('offers the passkey next to the authenticator code', () => {
    secure(true);
    // Without passkeys the authenticator code is the only proof, so no choice shows.
    renderCard('totp', vi.fn(), 0);
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    expect(screen.queryByLabelText('factorProof.chooseLabel')).toBeNull();
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProfileRecoveryCodes method="totp" remaining={0} passkeyCount={1} onCodes={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    const choice = screen.getByLabelText<HTMLSelectElement>('factorProof.chooseLabel');
    expect(Array.from(choice.options).map((o) => o.value)).toEqual(['passkey', 'totp']);
  });

  it('shows a closed passkey prompt as a quiet note and lets the user try again', async () => {
    secure(true);
    startAuthenticationMock.mockRejectedValue(
      Object.assign(new Error('closed'), { name: 'NotAllowedError' }),
    );
    postMock.mockResolvedValue({ challenge: 'c1' });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProfileRecoveryCodes method="" remaining={0} passkeyCount={1} onCodes={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesRegenerate' }));
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    const note = await screen.findByText('passkeys.cancelled');
    expect(note.className).toContain('text-muted-foreground');
    expect(screen.getByRole('button', { name: 'factorProof.passkeyButton' })).toBeTruthy();
  });
});

describe('RecoveryCodesDisplay', () => {
  it('lists every code once with a copy button and the store note', () => {
    const onDone = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RecoveryCodesDisplay codes={CODES} onDone={onDone} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(CODES);
    expect(screen.getByTestId('copy-button').textContent).toContain('profile.recoveryCodesCopy');
    expect(screen.getByText('profile.recoveryCodesStoreNote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesDone' }));
    expect(onDone).toHaveBeenCalled();
  });
  it('downloads the codes as a text file named after the company', async () => {
    const client = new QueryClient();
    // The branding the app already loaded names the file.
    client.setQueryData(['branding'], { name: 'Acme Charging' });
    const saved: { name: string; blob: Blob }[] = [];
    let lastBlob: Blob | undefined;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      lastBlob = blob;
      return 'blob:codes';
    });
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (lastBlob != null) saved.push({ name: this.download, blob: lastBlob });
    });
    try {
      render(
        <QueryClientProvider client={client}>
          <RecoveryCodesDisplay codes={CODES} onDone={vi.fn()} />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'profile.recoveryCodesDownload' }));
      expect(saved).toHaveLength(1);
      const [file] = saved;
      expect(file?.name).toBe('Acme-Charging-recovery-codes.txt');
      const lines = ((await file?.blob.text()) ?? '').split('\n');
      expect(lines[0]).toContain('profile.recoveryCodesFileHeader');
      expect(lines[0]).toContain(EMAIL);
      expect(lines.slice(2, 12)).toEqual(CODES);
      expect(revoke).toHaveBeenCalledWith('blob:codes');
    } finally {
      click.mockRestore();
    }
  });
});
