// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

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

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars?.['phone'] != null ? `${key}:${vars['phone']}` : key,
    i18n: { language: 'en' },
  }),
}));

// The proof field itself has its own tests: here it hands over a finished proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({ onChange }: { onChange: (p: unknown) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange({ kind: 'totp', code: '123456' });
      }}
    >
      give-proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { PhoneChangeProof, phoneChangeNeedsProof } from '../PhoneChangeProof';
import type { MfaStatus } from '../mfa-status';

const TOTP: MfaStatus = {
  mfaEnabled: true,
  mfaMethod: 'totp',
  availableMethods: ['totp'],
  factorProofKinds: ['totp'],
};
const SMS: MfaStatus = {
  mfaEnabled: true,
  mfaMethod: 'sms',
  availableMethods: ['sms'],
  factorProofKinds: ['code'],
};

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('phoneChangeNeedsProof', () => {
  it('asks only an account that holds a factor', () => {
    expect(phoneChangeNeedsProof(TOTP)).toBe(true);
    expect(
      phoneChangeNeedsProof({ ...TOTP, mfaEnabled: false, factorProofKinds: ['password'] }),
    ).toBe(false);
    expect(phoneChangeNeedsProof(undefined)).toBe(false);
  });
});

describe('PhoneChangeProof', () => {
  it('reports the proof of an account with an authenticator app', () => {
    const onChange = vi.fn();
    render(<PhoneChangeProof phone="+15550002222" status={TOTP} onChange={onChange} />);
    expect(screen.getByText('profile.phoneChangeProofHint')).toBeTruthy();
    fireEvent.click(screen.getByText('give-proof'));
    expect(onChange).toHaveBeenLastCalledWith({ proof: { kind: 'totp', code: '123456' } });
  });

  it('texts a code to the new number after the proof, then reports the code', async () => {
    postMock.mockResolvedValue({ challengeId: 41 });
    const onChange = vi.fn();
    render(<PhoneChangeProof phone=" +15550002222 " status={SMS} onChange={onChange} />);
    fireEvent.click(screen.getByText('profile.phoneSendCode'));
    expect(screen.getByRole('alert').textContent).toBe('factorProof.confirmFirst');
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('give-proof'));
    fireEvent.click(screen.getByText('profile.phoneSendCode'));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/users/me/phone-verification', {
        phone: '+15550002222',
        proof: { kind: 'totp', code: '123456' },
      });
    });
    expect(await screen.findByText('profile.phoneCodeSent:+15550002222')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('profile.phoneCode'), { target: { value: '98 76 54' } });
    expect(onChange).toHaveBeenLastCalledWith({
      phoneVerification: { challengeId: 41, code: '987654' },
    });
  });

  it('asks again for a code when the number changes after it was sent', async () => {
    postMock.mockResolvedValue({ challengeId: 41 });
    const onChange = vi.fn();
    const { rerender } = render(
      <PhoneChangeProof phone="+15550002222" status={SMS} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('give-proof'));
    fireEvent.click(screen.getByText('profile.phoneSendCode'));
    await screen.findByLabelText('profile.phoneCode');
    rerender(<PhoneChangeProof phone="+15550003333" status={SMS} onChange={onChange} />);
    expect(screen.queryByLabelText('profile.phoneCode')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
