// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

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
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

import { ApiError } from '@/lib/api';
import { PayoutOnboarding, PayoutOnboardingReturn } from '../PayoutOnboarding';

const assignMock = vi.fn();
const originalLocation = window.location;

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/payout-onboarding" element={<PayoutOnboarding />} />
        <Route path="/payout-onboarding/return" element={<PayoutOnboardingReturn />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign: assignMock, pathname: '/payout-onboarding', href: 'http://localhost/' },
  });
});

afterEach(() => {
  cleanup();
  postMock.mockReset();
  assignMock.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('PayoutOnboarding', () => {
  it('posts the token once and redirects to the Stripe onboarding link', async () => {
    postMock.mockResolvedValue({ url: 'https://connect.stripe.test/setup/abc', status: null });
    renderAt('/payout-onboarding?token=tok_1');
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('https://connect.stripe.test/setup/abc');
    });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payout-onboarding/link', {
      token: 'tok_1',
    });
    expect(screen.getByText('payoutOnboarding.redirecting')).toBeTruthy();
  });

  it('shows that the account is ready when there is nothing to onboard', async () => {
    postMock.mockResolvedValue({ url: null, status: 'active' });
    renderAt('/payout-onboarding?token=tok_1');
    expect(await screen.findByText('payoutOnboarding.ready')).toBeTruthy();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('asks for a new link on INVALID_TOKEN', async () => {
    postMock.mockRejectedValue(new ApiError(400, { code: 'INVALID_TOKEN' }));
    renderAt('/payout-onboarding?token=tok_old');
    expect(await screen.findByText('payoutOnboarding.invalidLink')).toBeTruthy();
    expect(screen.getByText('payoutOnboarding.askOperator')).toBeTruthy();
  });

  it('shows the invalid link message without calling the API when the token is missing', () => {
    renderAt('/payout-onboarding');
    expect(screen.getByText('payoutOnboarding.invalidLink')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('says onboarding is unavailable on PAYMENT_PROVIDER_NOT_CONFIGURED', async () => {
    postMock.mockRejectedValue(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' }));
    renderAt('/payout-onboarding?token=tok_1');
    expect(await screen.findByText('payoutOnboarding.notAvailable')).toBeTruthy();
  });

  it('offers a retry after another error', async () => {
    postMock
      .mockRejectedValueOnce(new ApiError(500, { code: 'INTERNAL_ERROR' }))
      .mockResolvedValueOnce({ url: 'https://connect.stripe.test/setup/retry', status: null });
    renderAt('/payout-onboarding?token=tok_1');
    fireEvent.click(await screen.findByRole('button', { name: 'errors.retry' }));
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('https://connect.stripe.test/setup/retry');
    });
    expect(postMock).toHaveBeenCalledTimes(2);
  });
});

describe('PayoutOnboardingReturn', () => {
  it.each([
    ['active', 'payoutOnboarding.ready'],
    ['pending', 'payoutOnboarding.pending'],
    ['disabled', 'payoutOnboarding.disabled'],
  ])('shows the %s status', async (status, text) => {
    postMock.mockResolvedValue({ status });
    renderAt('/payout-onboarding/return?token=tok_1');
    expect(await screen.findByText(text)).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payout-onboarding/status', {
      token: 'tok_1',
    });
    expect(screen.queryByText('payoutOnboarding.continueSetup')).toBeNull();
  });

  it('links back to onboarding when Stripe needs more information', async () => {
    postMock.mockResolvedValue({ status: 'action_required' });
    renderAt('/payout-onboarding/return?token=tok%201');
    expect(await screen.findByText('payoutOnboarding.actionRequired')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'payoutOnboarding.continueSetup' });
    expect(link.getAttribute('href')).toBe('/payout-onboarding?token=tok%201');
  });

  it('asks for a new link on INVALID_TOKEN', async () => {
    postMock.mockRejectedValue(new ApiError(400, { code: 'INVALID_TOKEN' }));
    renderAt('/payout-onboarding/return?token=tok_old');
    expect(await screen.findByText('payoutOnboarding.invalidLink')).toBeTruthy();
  });
});
