// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/verify-email?token=raw-token']}>
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
});
