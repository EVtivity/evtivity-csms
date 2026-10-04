// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const { postMock, toastMock } = vi.hoisted(() => ({ postMock: vi.fn(), toastMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { post: postMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['reason'] === 'string' ? `${key}:${opts['reason']}` : key,
  }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { PaymentReturn, parseReturn } from '../PaymentReturn';

function renderAt(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/payments/return" element={<PaymentReturn />} />
        <Route path="/payment-methods" element={<p>payment methods page</p>} />
        <Route path="/guest-session/:token" element={<p>guest session page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
  toastMock.mockReset();
});

describe('parseReturn', () => {
  it('reads the card save and guest return URLs', () => {
    expect(
      parseReturn(new URLSearchParams('flow=method&provider=adyen&attemptId=a1&redirectResult=rr')),
    ).toEqual({ flow: 'method', provider: 'adyen', attemptId: 'a1', redirectResult: 'rr' });
    expect(parseReturn(new URLSearchParams('flow=guest&token=t1&redirectResult=rr'))).toEqual({
      flow: 'guest',
      token: 't1',
      redirectResult: 'rr',
    });
  });

  it('refuses a return URL with a missing part', () => {
    expect(parseReturn(new URLSearchParams('flow=method&provider=adyen&attemptId=a1'))).toBeNull();
    expect(
      parseReturn(new URLSearchParams('flow=method&attemptId=a1&redirectResult=r')),
    ).toBeNull();
    expect(parseReturn(new URLSearchParams('flow=guest&redirectResult=r'))).toBeNull();
    expect(parseReturn(new URLSearchParams('flow=other&redirectResult=r'))).toBeNull();
  });
});

describe('PaymentReturn', () => {
  it('finishes a card save and opens the payment methods', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: 'pm_1' } });
    renderAt('/payments/return?flow=method&provider=adyen&attemptId=a1&redirectResult=rr');
    expect(await screen.findByText('payment methods page')).toBeTruthy();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payment-methods/setup/details', {
      provider: 'adyen',
      attemptId: 'a1',
      details: { details: { redirectResult: 'rr' } },
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'paymentProviders.adyen.return.cardSaved' }),
    );
  });

  it('shows a card refused after the verification', async () => {
    postMock.mockRejectedValue(
      new ApiError(400, {
        error: 'Payment failed',
        code: 'PAYMENT_FAILED',
        details: { reason: '3D Not Authenticated' },
      }),
    );
    renderAt('/payments/return?flow=method&provider=adyen&attemptId=a1&redirectResult=rr');
    expect(await screen.findByText('paymentProviders.refused.authentication_failed')).toBeTruthy();
    expect(screen.getByText('paymentProviders.adyen.return.backToMethods')).toBeTruthy();
  });

  it('finishes a guest hold and opens the guest session', async () => {
    postMock.mockResolvedValue({ status: 'started', sessionToken: 'tok_1' });
    renderAt('/payments/return?flow=guest&token=tok_1&redirectResult=rr');
    expect(await screen.findByText('guest session page')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/portal/guest/payment-details/tok_1', {
      details: { details: { redirectResult: 'rr' } },
    });
  });

  it('offers a retry when the details call fails', async () => {
    postMock.mockRejectedValue(new ApiError(0, null));
    renderAt('/payments/return?flow=guest&token=tok_1&redirectResult=rr');
    expect(await screen.findByRole('button', { name: 'errors.retry' })).toBeTruthy();
    expect(screen.getByText('paymentProviders.adyen.return.viewSession')).toBeTruthy();
  });

  it('explains an incomplete link without calling the API', () => {
    renderAt('/payments/return?flow=guest&token=tok_1');
    expect(screen.getByText('paymentProviders.adyen.return.invalid')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});
