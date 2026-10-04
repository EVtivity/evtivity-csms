// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { GuestPaymentProps, GuestPayResult, PaymentProviderModule } from '@/payments/types';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('@/lib/charger-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/charger-utils')>();
  return {
    ...actual,
    checkGuestConnectorStatus: vi.fn(() => Promise.resolve({ connectorStatus: 'occupied' })),
  };
});

/** A card module that asks for 3D Secure: it pays with a browser, then sends details. */
function ThreeDsGuestPayment({
  pay,
  payDetails,
  countryCode,
}: GuestPaymentProps): React.JSX.Element {
  const [result, setResult] = useState<GuestPayResult | null>(null);
  return (
    <div>
      <span>country {countryCode}</span>
      <button
        type="button"
        onClick={() => {
          void pay({ card: 'x' }, { origin: 'https://portal.test', info: { ua: 'u' } }).then(
            setResult,
          );
        }}
      >
        pay
      </button>
      {result?.status === 'action_required' && (
        <button
          type="button"
          onClick={() => {
            void payDetails(result.sessionToken, { details: { threeDSResult: 'r' } });
          }}
        >
          action for {result.sessionToken}
        </button>
      )}
    </div>
  );
}

const threeDsModule: PaymentProviderModule = {
  id: 'adyen',
  CardSetup: () => null,
  GuestPayment: ThreeDsGuestPayment,
};

vi.mock('@/payments/registry', () => ({
  loadPaymentModule: () => Promise.resolve(threeDsModule),
  isPaymentModuleRegistered: () => true,
}));

import { GuestCheckout } from '../GuestCheckout';

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('GuestCheckout with a 3D Secure step', () => {
  it('sends the browser, hands the action back and continues with the details', async () => {
    getMock.mockResolvedValue({
      paymentEnabled: true,
      isFree: false,
      paymentProvider: { provider: 'adyen', clientKey: 'k', environment: 'test' },
      currency: 'EUR',
      countryCode: 'NL',
      preAuthAmountCents: 5000,
    });
    postMock
      .mockResolvedValueOnce({
        status: 'action_required',
        sessionToken: 'tok_3ds',
        action: { provider: 'adyen', data: { type: 'redirect' } },
      })
      .mockResolvedValueOnce({ status: 'started', sessionToken: 'tok_3ds' });
    render(
      <MemoryRouter initialEntries={['/charge/CS-1/1/checkout']}>
        <Routes>
          <Route path="/charge/:stationId/:evseId/checkout" element={<GuestCheckout />} />
          <Route path="/guest-session/:token" element={<p>guest session page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('guest.emailForReceipt'), {
      target: { value: 'guest@example.com' },
    });
    expect(await screen.findByText('country NL')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'pay' }));
    fireEvent.click(await screen.findByRole('button', { name: 'action for tok_3ds' }));

    expect(await screen.findByText('guest session page')).toBeTruthy();
    expect(postMock).toHaveBeenNthCalledWith(1, '/v1/portal/guest/start/CS-1/1', {
      paymentMethod: {
        provider: 'adyen',
        payload: { card: 'x' },
        browser: { origin: 'https://portal.test', info: { ua: 'u' } },
      },
      guestEmail: 'guest@example.com',
    });
    expect(postMock).toHaveBeenNthCalledWith(2, '/v1/portal/guest/payment-details/tok_3ds', {
      details: { details: { threeDSResult: 'r' } },
    });
  });
});
