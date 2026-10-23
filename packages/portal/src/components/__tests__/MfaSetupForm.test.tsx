// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { ApiError };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MfaSetupForm } from '../MfaSetupForm';

afterEach(() => {
  cleanup();
});

function renderForm(props: Partial<React.ComponentProps<typeof MfaSetupForm>> = {}) {
  const setup = vi.fn(() => Promise.resolve({ challengeId: 3 }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MfaSetupForm
        availableMethods={['email', 'totp']}
        setup={setup}
        confirm={() => Promise.resolve({})}
        onConfirmed={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return setup;
}

describe('MfaSetupForm', () => {
  it('keeps Set Up enabled and asks for a method before it sends anything', () => {
    const setup = renderForm();
    const button = screen.getByRole('button', { name: 'profile.mfaSetUp' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole('alert').textContent).toBe('validation.selectRequired');
    expect(setup).not.toHaveBeenCalled();
  });

  it('sends nothing without the proof and tells the proof field', () => {
    const onProofMissing = vi.fn();
    const setup = renderForm({ proofReady: false, onProofMissing });
    fireEvent.change(screen.getByLabelText('profile.mfaSelectMethod'), {
      target: { value: 'email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    expect(onProofMissing).toHaveBeenCalledTimes(1);
    expect(setup).not.toHaveBeenCalled();
  });

  it('starts the setup once a method is chosen and the proof is there', async () => {
    const setup = renderForm();
    fireEvent.change(screen.getByLabelText('profile.mfaSelectMethod'), {
      target: { value: 'totp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    await waitFor(() => {
      expect(setup).toHaveBeenCalledWith('totp');
    });
  });
  it('keeps Verify enabled, names a short code after a submit and sends only six digits', async () => {
    const confirm = vi.fn(() => Promise.resolve({}));
    const setup = vi.fn(() =>
      Promise.resolve({ secret: 'ABCDEF', qrDataUri: 'data:image/png;base64,x' }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MfaSetupForm
          availableMethods={['totp']}
          setup={setup}
          confirm={confirm}
          onConfirmed={() => undefined}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    const code = await screen.findByLabelText('profile.mfaEnterCode');
    const verify = screen.getByRole('button', { name: 'profile.mfaVerify' });
    expect(verify.hasAttribute('disabled')).toBe(false);
    fireEvent.change(code, { target: { value: '12a3' } });
    expect((code as HTMLInputElement).value).toBe('123');
    fireEvent.click(verify);
    expect(screen.getByRole('alert').textContent).toBe('profile.mfaEnterCode');
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(code, { target: { value: '1234567' } });
    expect((code as HTMLInputElement).value).toBe('123456');
    fireEvent.click(verify);
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith({ method: 'totp', code: '123456' });
    });
  });

  it('offers a copy control for the manual entry key', async () => {
    const setup = vi.fn(() =>
      Promise.resolve({ secret: 'ABCDEF', qrDataUri: 'data:image/png;base64,x' }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MfaSetupForm
          availableMethods={['totp']}
          setup={setup}
          confirm={() => Promise.resolve({})}
          onConfirmed={() => undefined}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'profile.mfaSetUp' }));
    expect(await screen.findByRole('button', { name: 'common.copy' })).toBeTruthy();
  });
});
