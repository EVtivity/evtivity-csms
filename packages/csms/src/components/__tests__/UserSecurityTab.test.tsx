// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { missingPasswordRules } from '@evtivity/lib/password-policy';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

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
    api: { get: getMock, post: postMock },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'validation.passwordMissing'
        ? `missing: ${String(opts?.['rules'])}`
        : key.startsWith('validation.passwordRule.')
          ? key.slice('validation.passwordRule.'.length)
          : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { ApiError } from '@/lib/api';
import { UserSecurityTab } from '../user/UserSecurityTab';

const STRICT = {
  minLength: 20,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
};

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UserSecurityTab userId="usr_1" />
    </QueryClientProvider>,
  );
}

function rule(name: string): HTMLElement {
  const el = screen.getByTestId('password-requirements').querySelector(`[data-rule="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no rule ${name}`);
  return el;
}

function passwordField(): HTMLInputElement {
  const el = screen.getByLabelText('users.newPassword');
  if (!(el instanceof HTMLInputElement)) throw new Error('no password field');
  return el;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UserSecurityTab', () => {
  it('checks the live policy and generates a password that meets it', async () => {
    getMock.mockResolvedValue({ passwordPolicy: STRICT });
    renderTab();
    await waitFor(() => {
      expect(rule('symbol')).toBeTruthy();
    });

    fireEvent.change(passwordField(), { target: { value: 'Abcdefghijk1' } });
    fireEvent.click(screen.getByRole('button', { name: 'users.resetPassword' }));
    expect(screen.getByText('missing: minLength and symbol')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'users.generatePassword' }));
    const generated = passwordField().value;
    expect(generated).toHaveLength(20);
    expect(missingPasswordRules(generated, STRICT)).toEqual([]);
  });

  it('marks the rules a WEAK_PASSWORD reply names', async () => {
    getMock.mockResolvedValue({});
    postMock.mockRejectedValue(
      new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD', missing: ['symbol'] }),
    );
    renderTab();
    fireEvent.change(passwordField(), { target: { value: 'Abcdefghijk1' } });
    fireEvent.click(screen.getByRole('button', { name: 'users.resetPassword' }));
    expect(await screen.findByText('missing: symbol')).toBeTruthy();
    expect(rule('symbol').dataset.met).toBe('false');
    expect(postMock).toHaveBeenCalledWith('/v1/users/usr_1/reset-password', {
      password: 'Abcdefghijk1',
    });
  });
});
