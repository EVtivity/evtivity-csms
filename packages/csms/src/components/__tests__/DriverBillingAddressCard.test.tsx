// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock, toastMock, permission } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { get: getMock, patch: patchMock } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import {
  DriverBillingAddressCard,
  type DriverBillingAddress,
} from '../driver/DriverBillingAddressCard';

const EMPTY: DriverBillingAddress = {
  billingName: null,
  billingStreet: null,
  billingCity: null,
  billingState: null,
  billingZip: null,
  billingCountry: null,
};

const ADDRESS: DriverBillingAddress = {
  ...EMPTY,
  billingStreet: 'Hauptstrasse 1',
  billingCity: 'Berlin',
  billingZip: '10115',
  billingCountry: 'Germany',
};

function renderCard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverBillingAddressCard driver={{ id: 'drv_1', firstName: 'Jane', lastName: 'Doe' }} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
  toastMock.mockReset();
  permission.canWrite = true;
});

describe('DriverBillingAddressCard', () => {
  it('shows the driver name and the address lines', async () => {
    getMock.mockResolvedValue(ADDRESS);
    renderCard();
    expect(await screen.findByText('Hauptstrasse 1')).toBeTruthy();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('10115 Berlin')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/drivers/drv_1/billing-address');
  });

  it('warns when the driver has no address', async () => {
    getMock.mockResolvedValue(EMPTY);
    renderCard();
    expect(await screen.findByText('drivers.billingAddress.empty')).toBeTruthy();
  });

  it('hides the edit button without drivers:write', async () => {
    permission.canWrite = false;
    getMock.mockResolvedValue(ADDRESS);
    renderCard();
    await screen.findByText('Hauptstrasse 1');
    expect(screen.queryByRole('button', { name: /common\.edit/ })).toBeNull();
  });

  it('hides the edit button for an erased driver', async () => {
    getMock.mockResolvedValue(ADDRESS);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <DriverBillingAddressCard
          driver={{ id: 'drv_1', firstName: '', lastName: '', erasedAt: '2026-10-14T00:00:00Z' }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('Hauptstrasse 1');
    expect(screen.queryByRole('button', { name: /common\.edit/ })).toBeNull();
  });

  it('saves the trimmed form, blank fields as null', async () => {
    getMock.mockResolvedValue(ADDRESS);
    patchMock.mockResolvedValue({ ...ADDRESS, billingName: 'Acme Employee', billingCity: null });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /common\.edit/ }));
    fireEvent.change(screen.getByLabelText('drivers.billingAddress.name'), {
      target: { value: '  Acme Employee ' },
    });
    fireEvent.change(screen.getByLabelText('drivers.billingAddress.city'), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/drivers/drv_1/billing-address', {
        billingName: 'Acme Employee',
        billingStreet: 'Hauptstrasse 1',
        billingCity: null,
        billingState: null,
        billingZip: '10115',
        billingCountry: 'Germany',
      });
    });
    expect(await screen.findByText('Acme Employee')).toBeTruthy();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });
});
