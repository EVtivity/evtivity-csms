// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
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

import { ApiError } from '@/lib/api';
import { GuestCheckout } from '../GuestCheckout';

const simulatedConfig = {
  provider: 'simulated',
  resultMode: 'sync',
  testCards: [{ number: '4242424242424242', label: 'Approve (Visa)', scenario: 'approve' }],
};

function chargerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentEnabled: true,
    isFree: false,
    isSimulator: true,
    paymentProvider: simulatedConfig,
    currency: 'USD',
    preAuthAmountCents: 5000,
    ...overrides,
  };
}

function renderCheckout(): void {
  render(
    <MemoryRouter initialEntries={['/charge/CS-1/1/checkout?maxenergy=10000']}>
      <Routes>
        <Route path="/charge/:stationId/:evseId/checkout" element={<GuestCheckout />} />
        <Route path="/guest-session/:token" element={<p>guest session page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('GuestCheckout', () => {
  it('starts with the provider-tagged one-time method and opens the session', async () => {
    getMock.mockResolvedValue(chargerConfig());
    postMock.mockResolvedValue({ sessionToken: 'tok_guest_1' });
    renderCheckout();

    fireEvent.change(await screen.findByLabelText('guest.emailForReceipt'), {
      target: { value: 'guest@example.com' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'guest.startCharging' }));

    expect(await screen.findByText('guest session page')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/portal/guest/start/CS-1/1', {
      paymentMethod: { provider: 'simulated', payload: { testCard: '4242424242424242' } },
      guestEmail: 'guest@example.com',
      maxEnergyWh: 10000,
    });
  });

  it('asks for the email before starting', async () => {
    getMock.mockResolvedValue(chargerConfig());
    renderCheckout();
    fireEvent.click(await screen.findByRole('button', { name: 'guest.startCharging' }));
    expect(await screen.findByText('guest.emailRequired')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('shows the start error in the payment form', async () => {
    getMock.mockResolvedValue(chargerConfig());
    postMock.mockRejectedValue(new ApiError(400, { code: 'PAYMENT_FAILED', error: 'declined' }));
    renderCheckout();
    fireEvent.change(await screen.findByLabelText('guest.emailForReceipt'), {
      target: { value: 'guest@example.com' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'guest.startCharging' }));
    expect(await screen.findByText('translated:errors.PAYMENT_FAILED')).toBeTruthy();
  });

  it('shows payment not configured when no provider is active', async () => {
    getMock.mockResolvedValue(chargerConfig({ paymentEnabled: false, paymentProvider: null }));
    renderCheckout();
    expect(await screen.findByText('guest.paymentNotConfigured')).toBeTruthy();
  });

  it('shows not supported for a provider this portal has no module for', async () => {
    getMock.mockResolvedValue(chargerConfig({ paymentProvider: { provider: 'acme' } }));
    renderCheckout();
    expect(await screen.findByText('paymentProviders.providerNotSupported')).toBeTruthy();
  });

  it('needs no card at a free station', async () => {
    getMock.mockResolvedValue(chargerConfig({ isFree: true, paymentProvider: null }));
    renderCheckout();
    expect(await screen.findByText('charger.freeCharging')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('paymentProviders.simulated.testMode')).toBeNull();
    });
  });
});
