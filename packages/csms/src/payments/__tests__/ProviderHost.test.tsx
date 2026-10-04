// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CardSetupProps, PaymentProviderModule } from '../types';

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

const cardModule: PaymentProviderModule = {
  id: 'stripe',
  CardSetup: ({ session }) => <p>card setup for {session.customerId}</p>,
};

describe('ProviderHost', () => {
  afterEach(() => {
    cleanup();
    loadMock.mockReset();
  });

  it('shows not supported for a provider the app has no module for', () => {
    loadMock.mockReturnValue(null);
    render(<ProviderHost provider="bogus" props={cardProps()} />);
    expect(screen.getByText('paymentProviders.providerNotSupported')).toBeTruthy();
    expect(loadMock).toHaveBeenCalledWith('bogus');
  });

  it('shows the loading logo, then renders the module card setup with the host props', async () => {
    loadMock.mockReturnValue(Promise.resolve(cardModule));
    render(<ProviderHost provider="stripe" props={cardProps()} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText('card setup for cus_1')).toBeTruthy();
  });

  it('shows load failed with a retry that loads the module again', async () => {
    loadMock
      .mockReturnValueOnce(Promise.reject(new Error('chunk failed')))
      .mockReturnValueOnce(Promise.resolve(cardModule));
    render(<ProviderHost provider="stripe" props={cardProps()} />);
    expect(await screen.findByText('paymentProviders.loadFailed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('card setup for cus_1')).toBeTruthy();
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('switches modules when the provider changes', async () => {
    loadMock.mockReturnValueOnce(Promise.resolve(cardModule)).mockReturnValueOnce(null);
    const { rerender } = render(<ProviderHost provider="stripe" props={cardProps()} />);
    expect(await screen.findByText('card setup for cus_1')).toBeTruthy();
    rerender(<ProviderHost provider="other" props={cardProps()} />);
    expect(await screen.findByText('paymentProviders.providerNotSupported')).toBeTruthy();
  });
});
