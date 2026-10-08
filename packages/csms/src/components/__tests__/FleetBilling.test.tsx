// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { patchMock, getMock, toastMock, permission } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  getMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { patch: patchMock, get: getMock, delete: vi.fn() }, ApiError };
});

vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDate: (v: string) => v,
}));

import { FleetBillingTab } from '../fleet/FleetBillingTab';
import { FleetBillingProfileCard, parseContactEmails } from '../fleet/FleetBillingProfileCard';
import { FleetDriversTab } from '../fleet/FleetDriversTab';
import { DriverBillingCard } from '../driver/DriverBillingCard';
import { accountBillingState, isBilledOnAccount } from '@/lib/account-billing';

function wrap(node: React.ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permission.canWrite = true;
});

describe('FleetBillingTab', () => {
  it('turns charge on account on after confirmation', async () => {
    patchMock.mockResolvedValueOnce({ id: 'flt_1', accountBillingEnabled: true });
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: false }} />);

    expect(screen.getByText('fleets.billing.off')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'fleets.billing.chargeOnAccount' }));
    expect(screen.getByText('fleets.billing.enableConfirm')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'fleets.billing.enable' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/billing', {
        accountBillingEnabled: true,
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'fleets.billing.updated', variant: 'success' }),
      );
    });
  });

  it('asks to turn it off when it is on', () => {
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: true }} />);
    expect(screen.getByText('fleets.billing.on')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'fleets.billing.chargeOnAccount' }));
    expect(screen.getByText('fleets.billing.disableConfirm')).toBeTruthy();
  });

  it('disables the switch without fleets:write', () => {
    permission.canWrite = false;
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: false }} />);
    const toggle = screen.getByRole('switch', { name: 'fleets.billing.chargeOnAccount' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FleetDriversTab member billing', () => {
  const member = {
    id: 'drv_1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: null,
    phone: null,
    isActive: true,
    accountBillingOptOut: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('opts a member out of charge on account after confirmation', async () => {
    getMock.mockResolvedValue({ data: [member], total: 1 });
    patchMock.mockResolvedValueOnce({ fleetId: 'flt_1', driverId: 'drv_1' });
    wrap(<FleetDriversTab fleetId="flt_1" accountBillingEnabled />);

    const toggle = await screen.findByTestId('member-billing-drv_1');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.getByText('fleets.billing.optOutConfirm')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/drivers/drv_1', {
        accountBillingOptOut: true,
      });
    });
  });

  it('notes that members pay by card while the fleet does not bill on account', async () => {
    getMock.mockResolvedValue({ data: [{ ...member, accountBillingOptOut: true }], total: 1 });
    wrap(<FleetDriversTab fleetId="flt_1" accountBillingEnabled={false} />);

    expect(screen.getByText('fleets.billing.memberNoteOff')).toBeTruthy();
    const toggle = await screen.findByTestId('member-billing-drv_1');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

describe('DriverBillingCard', () => {
  it('shows the billing fleet and the pricing fleet of an account driver', () => {
    wrap(
      <DriverBillingCard
        billing={{
          mode: 'account',
          billingFleet: { id: 'flt_1', name: 'Acme' },
          pricingFleet: { id: 'flt_2', name: 'Priced' },
        }}
      />,
    );
    expect(screen.getByText('drivers.billing.modeAccount')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('/fleets/flt_1');
    expect(screen.getByRole('link', { name: 'Priced' }).getAttribute('href')).toBe('/fleets/flt_2');
  });

  it('shows a driver pricing group that overrides fleet pricing', () => {
    wrap(
      <DriverBillingCard
        billing={{
          mode: 'card',
          billingFleet: null,
          pricingFleet: null,
          pricingSource: 'driver',
          pricingGroup: { id: 'pgr_1', name: 'VIP' },
        }}
      />,
    );
    expect(screen.getByTestId('driver-pricing-override').textContent).toBe(
      'drivers.billing.pricingDriverGroup',
    );
  });

  it('shows card without fleets', () => {
    wrap(<DriverBillingCard billing={{ mode: 'card', billingFleet: null, pricingFleet: null }} />);
    expect(screen.getByText('drivers.billing.modeCard')).toBeTruthy();
    expect(screen.getAllByText('drivers.billing.none')).toHaveLength(2);
  });
});

describe('accountBillingState', () => {
  it('reads the billing state from the invoice status', () => {
    expect(accountBillingState(null)).toBe('unbilled');
    expect(accountBillingState('issued')).toBe('invoiced');
    expect(accountBillingState('paid')).toBe('paid');
  });

  it('shows account billing only for an account session without a payment record', () => {
    expect(isBilledOnAccount({ billingMode: 'account', paymentRecord: null })).toBe(true);
    expect(isBilledOnAccount({ billingMode: 'account', paymentRecord: { id: 1 } })).toBe(false);
    expect(isBilledOnAccount({ billingMode: 'card', paymentRecord: null })).toBe(false);
    expect(isBilledOnAccount({ billingMode: null })).toBe(false);
  });
});

describe('FleetBillingProfileCard', () => {
  const fleet = {
    id: 'flt_1',
    name: 'Acme Fleet',
    billingContactEmails: ['ap@acme.example'],
    billingLegalName: 'Acme GmbH',
    billingStreet: 'Hauptstrasse 1',
    billingCity: 'Berlin',
    billingState: null,
    billingZip: '10115',
    billingCountry: 'DE',
    billingTaxId: 'DE123456789',
    invoiceLanguage: 'de',
    paymentTermsDays: 14,
    autoInvoice: true,
  };

  it('splits contacts on lines, commas and semicolons', () => {
    expect(parseContactEmails(' a@x.example\nb@x.example, c@x.example; \n')).toEqual([
      'a@x.example',
      'b@x.example',
      'c@x.example',
    ]);
  });

  it('shows the saved profile', () => {
    wrap(<FleetBillingProfileCard fleet={fleet} />);
    expect(screen.getByText('ap@acme.example')).toBeTruthy();
    expect(screen.getByText('Acme GmbH')).toBeTruthy();
    expect(screen.getByText('10115 Berlin')).toBeTruthy();
    expect(screen.getByText('DE123456789')).toBeTruthy();
    expect(screen.getByText('Deutsch')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('fleets.billing.on')).toBeTruthy();
  });

  it('falls back to the fleet name and the default terms', () => {
    wrap(<FleetBillingProfileCard fleet={{ id: 'flt_1', name: 'Acme Fleet' }} />);
    expect(screen.getByText('Acme Fleet')).toBeTruthy();
    expect(screen.getByText('fleets.billingProfile.noContacts')).toBeTruthy();
    expect(screen.getByText('fleets.billingProfile.paymentTermsDefault')).toBeTruthy();
  });

  it('saves the edited profile', async () => {
    patchMock.mockResolvedValueOnce(fleet);
    wrap(<FleetBillingProfileCard fleet={fleet} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.contacts'), {
      target: { value: 'ap@acme.example\ncfo@acme.example' },
    });
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.taxId'), {
      target: { value: '  ' },
    });
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.paymentTerms'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/billing-profile', {
        billingContactEmails: ['ap@acme.example', 'cfo@acme.example'],
        billingLegalName: 'Acme GmbH',
        billingStreet: 'Hauptstrasse 1',
        billingCity: 'Berlin',
        billingState: null,
        billingZip: '10115',
        billingCountry: 'DE',
        billingTaxId: null,
        invoiceLanguage: 'de',
        paymentTermsDays: null,
        autoInvoice: true,
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'fleets.billingProfile.updated', variant: 'success' }),
      );
    });
  });

  it('blocks automatic invoicing without a contact and invalid terms', () => {
    wrap(<FleetBillingProfileCard fleet={fleet} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.contacts'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.paymentTerms'), {
      target: { value: '400' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(screen.getByText('errors.FLEET_BILLING_CONTACT_REQUIRED')).toBeTruthy();
    expect(screen.getByText('fleets.billingProfile.paymentTermsInvalid')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid email', () => {
    wrap(<FleetBillingProfileCard fleet={fleet} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.contacts'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(screen.getByText('fleets.billingProfile.contactsInvalid')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('hides editing without fleets:write', () => {
    permission.canWrite = false;
    wrap(<FleetBillingProfileCard fleet={fleet} />);
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();
  });
});
