// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CardSetupProps, GuestPaymentProps, PaymentProviderModule } from '../types';

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock('../registry', () => ({ loadPaymentModule: loadMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ProviderHost } from '../ProviderHost';

function cardProps(): CardSetupProps {
  return {
    session: { provider: 'stripe', customerId: 'cus_1' },
    submit: vi.fn(),
    submitDetails: vi.fn(),
    onSaved: vi.fn(),
    onCancel: vi.fn(),
  };
}

function guestProps(): GuestPaymentProps {
  return {
    config: { provider: 'stripe' },
    amountCents: 5000,
    currency: 'USD',
    disabled: false,
    pay: vi.fn(),
    payDetails: vi.fn(),
  };
}

const cardModule: PaymentProviderModule = {
  id: 'stripe',
  CardSetup: ({ session }) => <p>card setup for {session.customerId}</p>,
  GuestPayment: ({ amountCents }) => <p>guest payment {amountCents}</p>,
};

describe('ProviderHost', () => {
  afterEach(() => {
    cleanup();
    loadMock.mockReset();
  });

  it('shows not supported for a provider the app has no module for', () => {
    loadMock.mockReturnValue(null);
    render(<ProviderHost provider="bogus" component="CardSetup" props={cardProps()} />);
    expect(screen.getByText('paymentProviders.providerNotSupported')).toBeTruthy();
    expect(loadMock).toHaveBeenCalledWith('bogus');
  });

  it('shows a spinner, then renders the module card setup with the host props', async () => {
    loadMock.mockReturnValue(Promise.resolve(cardModule));
    render(<ProviderHost provider="stripe" component="CardSetup" props={cardProps()} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText('card setup for cus_1')).toBeTruthy();
  });

  it('renders the guest payment component', async () => {
    loadMock.mockReturnValue(Promise.resolve(cardModule));
    render(<ProviderHost provider="stripe" component="GuestPayment" props={guestProps()} />);
    expect(await screen.findByText('guest payment 5000')).toBeTruthy();
  });

  it('shows not supported when the module has no guest payment', async () => {
    loadMock.mockReturnValue(Promise.resolve({ id: 'x', CardSetup: cardModule.CardSetup }));
    render(<ProviderHost provider="x" component="GuestPayment" props={guestProps()} />);
    expect(await screen.findByText('paymentProviders.providerNotSupported')).toBeTruthy();
  });

  it('shows load failed with a retry that loads the module again', async () => {
    loadMock
      .mockReturnValueOnce(Promise.reject(new Error('chunk failed')))
      .mockReturnValueOnce(Promise.resolve(cardModule));
    render(<ProviderHost provider="stripe" component="CardSetup" props={cardProps()} />);
    expect(await screen.findByText('paymentProviders.loadFailed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'errors.retry' }));
    expect(await screen.findByText('card setup for cus_1')).toBeTruthy();
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
