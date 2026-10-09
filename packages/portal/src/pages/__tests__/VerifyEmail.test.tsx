// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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
  return {
    api: { get: vi.fn().mockResolvedValue({}), post: postMock },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { driver: null }) => unknown) => selector({ driver: null }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { ApiError } from '@/lib/api';
import { VerifyEmail } from '../VerifyEmail';

function renderPage(path = '/verify-email?token=raw-token'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <VerifyEmail />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('VerifyEmail', () => {
  it('keeps the verification link text for an invalid token', async () => {
    postMock.mockRejectedValue(new ApiError(400, { error: 'x', code: 'INVALID_TOKEN' }));
    renderPage();
    expect(await screen.findByText('auth.verifyEmailFailed')).toBeTruthy();
  });

  it('shows the translated API error for other failures', async () => {
    postMock.mockRejectedValue(new ApiError(429, { error: 'x', code: 'RATE_LIMITED' }));
    renderPage();
    expect(await screen.findByText('translated:errors.RATE_LIMITED')).toBeTruthy();
  });

  it('falls back to the verification text when the request does not reach the API', async () => {
    postMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();
    expect(await screen.findByText('auth.verifyEmailFailed')).toBeTruthy();
  });

  describe('check your email', () => {
    it('fills the app layout content area and centers the card in it', () => {
      renderPage('/verify-email');
      const wrapper = screen.getByTestId('verify-email-pending');
      // Inside Layout's <main> (a flex column): flex-1 fills it, min-h-screen overflowed it.
      expect(wrapper.className).toContain('flex-1');
      expect(wrapper.className).toContain('justify-center');
      expect(wrapper.className).toContain('items-center');
      expect(wrapper.className).not.toContain('min-h-screen');
    });

    it('shows the per-account resend limit and disables the button for the wait', async () => {
      postMock.mockRejectedValue(
        new ApiError(429, {
          error: 'x',
          code: 'VERIFICATION_RESEND_LIMITED',
          retryAfterSeconds: 45,
        }),
      );
      renderPage('/verify-email');
      fireEvent.click(screen.getByRole('button', { name: 'auth.resendVerification' }));
      expect(await screen.findByText('translated:errors.VERIFICATION_RESEND_LIMITED')).toBeTruthy();
      const button = screen.getByRole('button', { name: 'auth.resendVerificationCooldown' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the button disabled without a countdown for a wait longer than a minute', async () => {
      postMock.mockRejectedValue(
        new ApiError(429, {
          error: 'x',
          code: 'VERIFICATION_RESEND_LIMITED',
          retryAfterSeconds: 3600,
        }),
      );
      renderPage('/verify-email');
      fireEvent.click(screen.getByRole('button', { name: 'auth.resendVerification' }));
      expect(await screen.findByText('translated:errors.VERIFICATION_RESEND_LIMITED')).toBeTruthy();
      const button = screen.getByRole('button', { name: 'auth.resendVerification' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
