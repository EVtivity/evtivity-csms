// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { GuestPaymentProps, PaymentProviderModule } from '@/payments/types';

// A stable t, as i18next gives: the charger-config effect depends on it.
const { getMock, postMock, translation } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => translation,
}));

vi.mock('@/lib/guest-start', () => ({
  guestStartExtras: vi.fn((_s: string, _e: string, language: string) =>
    Promise.resolve({ language }),
  ),
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

const mounts: string[] = [];

/** A Stripe-like module that shows the payout account its form was built for. */
function StubGuestPayment({ config, pay }: GuestPaymentProps): React.JSX.Element {
  const onBehalfOf = typeof config['onBehalfOf'] === 'string' ? config['onBehalfOf'] : 'none';
  mounts.push(onBehalfOf);
  return (
    <div>
      <span>form for {onBehalfOf}</span>
      <button
        type="button"
        onClick={() => {
          void pay('pm_wallet').catch(() => undefined);
        }}
      >
        pay
      </button>
    </div>
  );
}

const stubModule: PaymentProviderModule = {
  id: 'stripe',
  CardSetup: () => null,
  GuestPayment: StubGuestPayment,
};

vi.mock('@/payments/registry', () => ({
  loadPaymentModule: () => Promise.resolve(stubModule),
  isPaymentModuleRegistered: () => true,
}));

import { ApiError } from '@/lib/api';
import { GuestCheckout } from '../GuestCheckout';

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  mounts.length = 0;
});

function chargerConfig(onBehalfOf: string | null): Record<string, unknown> {
  return {
    paymentEnabled: true,
    isFree: false,
    paymentProvider: { provider: 'stripe', publishableKey: 'pk_test', onBehalfOf },
    currency: 'USD',
    preAuthAmountCents: 5000,
  };
}

function renderCheckout(): void {
  render(
    <MemoryRouter initialEntries={['/charge/CS-1/1/checkout']}>
      <Routes>
        <Route path="/charge/:stationId/:evseId/checkout" element={<GuestCheckout />} />
        <Route path="/guest-session/:token" element={<p>guest session page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GuestCheckout when the payment setup changed', () => {
  it('sends the payout account of the form with the start', async () => {
    getMock.mockResolvedValue(chargerConfig('acct_site'));
    postMock.mockResolvedValueOnce({ status: 'started', sessionToken: 'tok_1' });
    renderCheckout();

    fireEvent.change(await screen.findByLabelText('guest.emailForReceipt'), {
      target: { value: 'guest@example.com' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'pay' }));

    expect(await screen.findByText('guest session page')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/portal/guest/start/CS-1/1', {
      paymentMethod: { provider: 'stripe', payload: 'pm_wallet' },
      onBehalfOf: 'acct_site',
      guestEmail: 'guest@example.com',
      language: 'en',
    });
  });

  it('sends null for a form built without a payout account', async () => {
    getMock.mockResolvedValue(chargerConfig(null));
    postMock.mockResolvedValueOnce({ status: 'started', sessionToken: 'tok_1' });
    renderCheckout();

    fireEvent.change(await screen.findByLabelText('guest.emailForReceipt'), {
      target: { value: 'guest@example.com' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'pay' }));

    await screen.findByText('guest session page');
    expect(postMock.mock.calls[0]?.[1]).toMatchObject({ onBehalfOf: null });
  });

  it('reloads the charger config, builds a new form and says why', async () => {
    getMock
      .mockResolvedValueOnce(chargerConfig(null))
      .mockResolvedValueOnce(chargerConfig('acct_site'));
    postMock.mockRejectedValueOnce(
      new ApiError(409, {
        error: 'The payment setup of this charger changed. Reload the payment form',
        code: 'PAYMENT_SETUP_CHANGED',
      }),
    );
    renderCheckout();

    const email = await screen.findByLabelText('guest.emailForReceipt');
    fireEvent.change(email, { target: { value: 'guest@example.com' } });
    expect(await screen.findByText('form for none')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pay' }));

    expect(
      await screen.findByText('The payment setup of this charger changed. Reload the payment form'),
    ).toBeTruthy();
    expect(await screen.findByText('form for acct_site')).toBeTruthy();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(2);
    });
    // The typed email stays: only the payment form is built again.
    expect(screen.getByLabelText<HTMLInputElement>('guest.emailForReceipt').value).toBe(
      'guest@example.com',
    );
    expect(mounts).toContain('acct_site');
  });
});
