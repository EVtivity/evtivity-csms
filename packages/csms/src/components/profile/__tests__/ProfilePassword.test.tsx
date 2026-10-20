// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
import { ProfilePassword } from '../ProfilePassword';

const STRICT = {
  minLength: 14,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
};

function securityCalls(): number {
  return getMock.mock.calls.filter(([path]) => path === '/v1/security/public').length;
}

function rule(name: string): HTMLElement {
  const el = screen.getByTestId('password-requirements').querySelector(`[data-rule="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no rule ${name}`);
  return el;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProfilePassword />
    </QueryClientProvider>,
  );
}

function fill(password: string): void {
  fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
    target: { value: 'Current-Password-1' },
  });
  fireEvent.change(screen.getByLabelText('profile.newPassword'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('profile.confirmPassword'), {
    target: { value: password },
  });
}

describe('ProfilePassword', () => {
  it('checks the policy the API publishes', async () => {
    getMock.mockResolvedValue({ passwordPolicy: STRICT });
    renderCard();
    await waitFor(() => {
      expect(rule('symbol')).toBeTruthy();
    });
    fill('Abcdefghijk1');
    fireEvent.click(screen.getByRole('button', { name: 'profile.changePassword' }));
    expect(screen.getByText('missing: minLength and symbol')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    const field = screen.getByLabelText('profile.newPassword');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(
      'new-password-error new-password-requirements',
    );
  });

  it('marks the rules a WEAK_PASSWORD reply names and reloads the policy', async () => {
    getMock.mockResolvedValue({});
    postMock.mockRejectedValue(
      new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD', missing: ['symbol'] }),
    );
    renderCard();
    await waitFor(() => {
      expect(securityCalls()).toBe(1);
    });
    const field = screen.getByLabelText('profile.newPassword');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBe('new-password-requirements');
    fill('Abcdefghijk1');
    fireEvent.click(screen.getByRole('button', { name: 'profile.changePassword' }));
    expect(await screen.findByText('missing: symbol')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/users/me/change-password', expect.anything());
    expect(rule('symbol').dataset.met).toBe('false');
    await waitFor(() => {
      expect(securityCalls()).toBe(2);
    });
  });
});
