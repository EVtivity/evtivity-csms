// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

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

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { PaymentReturn, parseReturn } from '../PaymentReturn';

function DriverPage(): React.JSX.Element {
  const location = useLocation();
  return <p>driver page {location.search}</p>;
}

function renderAt(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/payments/return" element={<PaymentReturn />} />
        <Route path="/drivers/:id" element={<DriverPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const url =
  '/payments/return?flow=method&provider=adyen&attemptId=a1&driverId=drv_1&redirectResult=rr';

afterEach(() => {
  cleanup();
  postMock.mockReset();
  toastMock.mockReset();
});

describe('parseReturn', () => {
  it('needs every part of an operator card save return', () => {
    expect(parseReturn(new URL(`https://x${url}`).searchParams)).toEqual({
      provider: 'adyen',
      attemptId: 'a1',
      driverId: 'drv_1',
      redirectResult: 'rr',
    });
    expect(
      parseReturn(new URLSearchParams('flow=method&provider=adyen&attemptId=a1&redirectResult=rr')),
    ).toBeNull();
    expect(parseReturn(new URLSearchParams('flow=guest&token=t&redirectResult=rr'))).toBeNull();
  });
});

describe('PaymentReturn', () => {
  it('finishes the card save and opens the driver payment methods', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: 'pm_1' } });
    renderAt(url);
    expect(await screen.findByText('driver page ?tab=payment-methods')).toBeTruthy();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/payment-methods/setup/details', {
      provider: 'adyen',
      attemptId: 'a1',
      details: { details: { redirectResult: 'rr' } },
    });
    expect(toastMock).toHaveBeenCalled();
  });

  it('shows the refusal reason', async () => {
    postMock.mockRejectedValue(
      new ApiError(400, {
        error: 'Payment failed',
        code: 'PAYMENT_FAILED',
        details: { reason: 'Refused' },
      }),
    );
    renderAt(url);
    expect(await screen.findByText('paymentProviders.adyen.refused:Refused')).toBeTruthy();
  });

  it('offers a retry when the call fails', async () => {
    postMock.mockRejectedValue(new ApiError(0, null));
    renderAt(url);
    expect(await screen.findByRole('button', { name: 'common.retry' })).toBeTruthy();
  });

  it('explains an incomplete link', () => {
    renderAt('/payments/return?flow=method&provider=adyen');
    expect(screen.getByText('paymentProviders.adyen.return.invalid')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});
