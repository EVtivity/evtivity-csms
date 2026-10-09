// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

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
    api: {
      get: vi.fn().mockResolvedValue({ mfaEnabled: false, mfaMethod: null, availableMethods: [] }),
      patch: patchMock,
      post: vi.fn(),
      delete: vi.fn(),
    },
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

function submitPasswordChange(newPassword = 'New-Password-123'): void {
  fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
    target: { value: 'old-password' },
  });
  fireEvent.change(screen.getByLabelText('profile.newPassword'), {
    target: { value: newPassword },
  });
  fireEvent.click(screen.getByRole('button', { name: 'profile.changePassword' }));
}

afterEach(() => {
  cleanup();
  patchMock.mockReset();
});

describe('AccountSecurity password change', () => {
  it('shows the translated API error', async () => {
    patchMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'INVALID_PASSWORD' }));
    render(<AccountSecurity />);
    submitPasswordChange();
    expect(await screen.findByText('translated:errors.INVALID_PASSWORD')).toBeTruthy();
  });

  it('shows the password requirements and names the missing rules before calling the API', () => {
    render(<AccountSecurity />);
    expect(screen.getByTestId('password-requirements')).toBeTruthy();
    submitPasswordChange('lowercaseonly');
    expect(screen.getByText('validation.passwordMissing')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('explains a WEAK_PASSWORD reply at the field', async () => {
    patchMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD' }));
    render(<AccountSecurity />);
    submitPasswordChange();
    expect(await screen.findByText('translated:errors.WEAK_PASSWORD')).toBeTruthy();
  });

  it('falls back to the generic text when the request does not reach the API', async () => {
    patchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<AccountSecurity />);
    submitPasswordChange();
    expect(await screen.findByText('profile.passwordChangeFailed')).toBeTruthy();
  });
});
