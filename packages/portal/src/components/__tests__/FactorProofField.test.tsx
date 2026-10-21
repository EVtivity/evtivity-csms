// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { postMock, startAuthenticationMock, supportsMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
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
  return { api: { post: postMock }, ApiError };
});

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: supportsMock,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startAuthentication: startAuthenticationMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

import { ApiError } from '@/lib/api';
import { FactorProofField, type FactorProof } from '../FactorProofField';

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function renderField(
  kinds: string[],
  extra: Partial<React.ComponentProps<typeof FactorProofField>> = {},
): ReturnType<typeof vi.fn<(p: FactorProof | null) => void>> {
  const onChange = vi.fn<(p: FactorProof | null) => void>();
  render(<FactorProofField idPrefix="t" kinds={kinds} onChange={onChange} {...extra} />);
  return onChange;
}

function lastProof(onChange: ReturnType<typeof vi.fn>): unknown {
  return onChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  postMock.mockReset();
  startAuthenticationMock.mockReset();
  supportsMock.mockReturnValue(true);
  secure(true);
});

afterEach(() => {
  cleanup();
});

describe('FactorProofField', () => {
  it('renders nothing for an account that needs no proof', () => {
    renderField([]);
    expect(screen.queryByTestId('factor-proof')).toBeNull();
  });

  it('reports the password once it is typed', () => {
    const onChange = renderField(['password']);
    expect(lastProof(onChange)).toBeNull();
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'pw-1' },
    });
    expect(lastProof(onChange)).toEqual({ kind: 'password', password: 'pw-1' });
  });

  it('reports an authenticator code only with six digits', () => {
    const onChange = renderField(['totp']);
    const input = screen.getByLabelText('factorProof.totpLabel');
    fireEvent.change(input, { target: { value: '12345' } });
    expect(lastProof(onChange)).toBeNull();
    fireEvent.change(input, { target: { value: '123456' } });
    expect(lastProof(onChange)).toEqual({ kind: 'totp', code: '123456' });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('reports a recovery code as typed, trimmed, and sends nothing', () => {
    const onChange = renderField(['recovery_code']);
    const input = screen.getByLabelText<HTMLInputElement>('factorProof.recoveryCodeLabel');
    expect(input.autocomplete).toBe('off');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(lastProof(onChange)).toBeNull();
    fireEvent.change(input, { target: { value: ' abcde-fghjk ' } });
    expect(lastProof(onChange)).toEqual({ kind: 'recovery_code', recoveryCode: 'abcde-fghjk' });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('offers the recovery code after the factors and before the password', () => {
    renderField(['password', 'recovery_code', 'totp']);
    const choice = screen.getByLabelText<HTMLSelectElement>('factorProof.chooseLabel');
    expect(Array.from(choice.options).map((o) => o.value)).toEqual([
      'totp',
      'recovery_code',
      'password',
    ]);
    expect(choice.options[1]?.textContent).toBe('factorProof.kindRecoveryCode');
  });

  it('sends an email code at once and reports it with its challenge', async () => {
    postMock.mockResolvedValue({ challengeId: 9 });
    const onChange = renderField(['code'], { codeMethod: 'email' });
    await screen.findByText('factorProof.codeSentEmail');
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/v1/portal/driver/mfa/factor-proof', { kind: 'code' });
    fireEvent.change(screen.getByLabelText('factorProof.codeLabel'), {
      target: { value: '654321' },
    });
    expect(lastProof(onChange)).toEqual({ kind: 'code', code: '654321', challengeId: 9 });
  });

  it('sends a new code on request and says a text message went out for SMS', async () => {
    postMock.mockResolvedValueOnce({ challengeId: 1 }).mockResolvedValueOnce({ challengeId: 2 });
    const onChange = renderField(['code'], { codeMethod: 'sms' });
    await screen.findByText('factorProof.codeSentSms');
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.resend' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(2);
    });
    fireEvent.change(screen.getByLabelText('factorProof.codeLabel'), {
      target: { value: '111111' },
    });
    await waitFor(() => {
      expect(lastProof(onChange)).toEqual({ kind: 'code', code: '111111', challengeId: 2 });
    });
  });

  it('shows the translated refusal when the code cannot be sent', async () => {
    postMock.mockRejectedValue(new ApiError(429, { code: 'MFA_RESEND_LIMITED' }));
    renderField(['code']);
    expect(await screen.findByText('translated:errors.MFA_RESEND_LIMITED')).toBeTruthy();
  });

  it('verifies a passkey through the factor proof challenge', async () => {
    const options = { challenge: 'abc', allowCredentials: [] };
    const credential = { id: 'cred', type: 'public-key' };
    postMock.mockResolvedValue({ options });
    startAuthenticationMock.mockResolvedValue(credential);
    const onChange = renderField(['passkey']);
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    await screen.findByText('factorProof.passkeyVerified');
    expect(postMock).toHaveBeenCalledWith('/v1/portal/driver/mfa/factor-proof', {
      kind: 'passkey',
    });
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: options });
    // The proof reaches onChange from an effect after the verified note renders.
    await waitFor(() => {
      expect(lastProof(onChange)).toEqual({ kind: 'passkey', credential });
    });
  });

  it('fetches the passkey options before the click, so the click starts the prompt at once', async () => {
    const options = { challenge: 'pre', allowCredentials: [] };
    postMock.mockResolvedValue({ options });
    startAuthenticationMock.mockReturnValue(new Promise(() => undefined));
    renderField(['passkey']);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/driver/mfa/factor-proof', {
        kind: 'passkey',
      });
    });
    // Let the prefetch settle before the click.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    // No await between the click and the prompt: Safari keeps the click's activation.
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: options });
  });

  it('shows a failed passkey check as an error', async () => {
    postMock.mockRejectedValue(new ApiError(400, { code: 'MFA_NOT_CONFIGURED' }));
    const onChange = renderField(['passkey']);
    fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
    const error = await screen.findByText('translated:errors.MFA_NOT_CONFIGURED');
    expect(error.className).toContain('text-destructive');
    expect(lastProof(onChange)).toBeNull();
  });

  it('defaults to the passkey and lets the user switch to another factor', async () => {
    postMock.mockImplementation((_path: string, body: { kind: string }) =>
      Promise.resolve(body.kind === 'code' ? { challengeId: 3 } : { options: { challenge: 'x' } }),
    );
    renderField(['totp', 'code', 'passkey'], { codeMethod: 'email' });
    const choice = screen.getByLabelText<HTMLSelectElement>('factorProof.chooseLabel');
    expect(choice.value).toBe('passkey');
    expect(Array.from(choice.options).map((o) => o.value)).toEqual(['passkey', 'totp', 'code']);
    // A passkey sends no code: only its options are fetched ahead of the click.
    expect(postMock).not.toHaveBeenCalledWith('/v1/portal/driver/mfa/factor-proof', {
      kind: 'code',
    });
    fireEvent.change(choice, { target: { value: 'code' } });
    await screen.findByText('factorProof.codeSentEmail');
    expect(
      postMock.mock.calls.filter((c) => (c[1] as { kind: string }).kind === 'code'),
    ).toHaveLength(1);
  });

  it('keeps the sent code when the user switches away and back', async () => {
    postMock.mockResolvedValue({ challengeId: 5 });
    const onChange = renderField(['totp', 'code'], { codeMethod: 'email' });
    const choice = screen.getByLabelText<HTMLSelectElement>('factorProof.chooseLabel');
    fireEvent.change(choice, { target: { value: 'code' } });
    await screen.findByText('factorProof.codeSentEmail');
    fireEvent.change(choice, { target: { value: 'totp' } });
    fireEvent.change(choice, { target: { value: 'code' } });
    fireEvent.change(screen.getByLabelText('factorProof.codeLabel'), {
      target: { value: '123123' },
    });
    expect(lastProof(onChange)).toEqual({ kind: 'code', code: '123123', challengeId: 5 });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('says the proof is missing once the user tried to continue', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FactorProofField idPrefix="t" kinds={['password']} onChange={onChange} />,
    );
    expect(screen.queryByText('factorProof.confirmFirst')).toBeNull();
    rerender(
      <FactorProofField idPrefix="t" kinds={['password']} onChange={onChange} showMissing />,
    );
    expect(screen.getByRole('alert').textContent).toBe('factorProof.confirmFirst');
    fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
      target: { value: 'pw' },
    });
    expect(screen.queryByText('factorProof.confirmFirst')).toBeNull();
  });

  describe('after a failed call that carried the proof', () => {
    function renderWith(kinds: string[], extra: Record<string, unknown> = {}) {
      const onChange = vi.fn<(p: FactorProof | null) => void>();
      const view = render(
        <FactorProofField idPrefix="t" kinds={kinds} onChange={onChange} {...extra} />,
      );
      const reject = (code: string | null): void => {
        view.rerender(
          <FactorProofField
            idPrefix="t"
            kinds={kinds}
            onChange={onChange}
            {...extra}
            rejection={{ code }}
          />,
        );
      };
      return { onChange, reject };
    }

    it('clears only the input after a wrong code and keeps the challenge', async () => {
      postMock.mockResolvedValue({ challengeId: 9 });
      const { onChange, reject } = renderWith(['code'], { codeMethod: 'email' });
      await screen.findByText('factorProof.codeSentEmail');
      const input = screen.getByLabelText<HTMLInputElement>('factorProof.codeLabel');
      fireEvent.change(input, { target: { value: '111111' } });
      reject('MFA_CODE_INVALID');
      expect(input.value).toBe('');
      expect(lastProof(onChange)).toBeNull();
      fireEvent.change(input, { target: { value: '222222' } });
      expect(lastProof(onChange)).toEqual({ kind: 'code', code: '222222', challengeId: 9 });
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it('sends a new code when the challenge is used up', async () => {
      postMock.mockResolvedValueOnce({ challengeId: 1 }).mockResolvedValueOnce({ challengeId: 2 });
      const { onChange, reject } = renderWith(['code'], { codeMethod: 'email' });
      await screen.findByText('factorProof.codeSentEmail');
      reject('MFA_CHALLENGE_EXHAUSTED');
      await waitFor(() => {
        expect(postMock).toHaveBeenCalledTimes(2);
      });
      fireEvent.change(screen.getByLabelText('factorProof.codeLabel'), {
        target: { value: '333333' },
      });
      await waitFor(() => {
        expect(lastProof(onChange)).toEqual({ kind: 'code', code: '333333', challengeId: 2 });
      });
    });

    it('sends a new code when the failure came after the proof was accepted', async () => {
      postMock.mockResolvedValueOnce({ challengeId: 1 }).mockResolvedValueOnce({ challengeId: 2 });
      const { reject } = renderWith(['code'], { codeMethod: 'sms' });
      await screen.findByText('factorProof.codeSentSms');
      reject('WEBAUTHN_VERIFICATION_FAILED');
      await waitFor(() => {
        expect(postMock).toHaveBeenCalledTimes(2);
      });
    });

    it('asks for the passkey again, since each response works once', async () => {
      const options = { challenge: 'abc' };
      postMock.mockResolvedValue({ options });
      startAuthenticationMock.mockResolvedValue({ id: 'cred', type: 'public-key' });
      const { onChange, reject } = renderWith(['passkey']);
      fireEvent.click(screen.getByRole('button', { name: 'factorProof.passkeyButton' }));
      await screen.findByText('factorProof.passkeyVerified');
      reject(null);
      expect(lastProof(onChange)).toBeNull();
      expect(screen.getByRole('button', { name: 'factorProof.passkeyButton' })).toBeTruthy();
    });

    it('clears the recovery code, since the API may have used it up', () => {
      const { onChange, reject } = renderWith(['recovery_code']);
      const input = screen.getByLabelText<HTMLInputElement>('factorProof.recoveryCodeLabel');
      fireEvent.change(input, { target: { value: 'abcde-fghjk' } });
      reject('MFA_CODE_INVALID');
      expect(input.value).toBe('');
      expect(lastProof(onChange)).toBeNull();
    });

    it('clears a wrong password and keeps a right one', () => {
      const { onChange, reject } = renderWith(['password']);
      const input = screen.getByLabelText<HTMLInputElement>('profile.currentPassword');
      fireEvent.change(input, { target: { value: 'pw' } });
      reject('WEBAUTHN_VERIFICATION_FAILED');
      expect(lastProof(onChange)).toEqual({ kind: 'password', password: 'pw' });
      reject('INVALID_PASSWORD');
      expect(input.value).toBe('');
      expect(lastProof(onChange)).toBeNull();
    });
  });

  it('drops the passkey outside a secure page', () => {
    secure(false);
    renderField(['totp', 'passkey']);
    expect(screen.queryByLabelText('factorProof.chooseLabel')).toBeNull();
    expect(screen.getByLabelText('factorProof.totpLabel')).toBeTruthy();
  });

  it('explains a passkey-only proof on a page that cannot use passkeys', () => {
    supportsMock.mockReturnValue(false);
    renderField(['passkey']);
    expect(screen.getByText('factorProof.passkeyNeedsSecurePage')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'factorProof.passkeyButton' })).toBeNull();
  });
});
