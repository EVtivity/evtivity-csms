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
  permission: { canWrite: true, allSites: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { time?: string }) =>
      opts?.time != null ? `${key} ${opts.time}` : key,
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
  const getApiErrorCode = (err: unknown): string | null =>
    err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null;
  return { api: { patch: patchMock, get: getMock, delete: vi.fn() }, ApiError, getApiErrorCode };
});

vi.mock('@/lib/auth', () => ({
  useHasPermission: () => permission.canWrite,
  useHasAllSiteAccess: () => permission.allSites,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'Europe/Berlin',
  formatDate: (v: string) => v,
  formatDateTime: (v: string, tz: string) => `${v}@${tz}`,
}));

import { FleetBillingTab, oldProcessAllowedFrom } from '../fleet/FleetBillingTab';
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
  permission.allSites = true;
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

  it('switches the invoice recipient to each driver after confirmation', async () => {
    patchMock.mockResolvedValueOnce({ id: 'flt_1', accountInvoiceRecipient: 'member' });
    wrap(
      <FleetBillingTab
        fleet={{ id: 'flt_1', accountBillingEnabled: true, accountInvoiceRecipient: 'fleet' }}
      />,
    );
    expect(screen.getByText('fleets.billing.recipientHelpFleet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('fleets.billing.invoiceTo'), {
      target: { value: 'member' },
    });
    expect(screen.getByText('fleets.billing.recipientConfirmMember')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'fleets.billing.recipientChange' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/billing', {
        accountInvoiceRecipient: 'member',
      });
    });
  });

  it('shows the old-release refusal inline instead of a toast', async () => {
    const { ApiError } = await import('@/lib/api');
    patchMock.mockRejectedValueOnce(
      new ApiError(409, {
        error: 'A process older than v0.1.46 is still connected.',
        code: 'FLEET_BILLING_OLD_PODS_CONNECTED',
      }),
    );
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: true }} />);
    fireEvent.change(screen.getByLabelText('fleets.billing.invoiceTo'), {
      target: { value: 'member' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'fleets.billing.recipientChange' }));
    expect(await screen.findByTestId('fleet-billing-upgrade-error')).toBeTruthy();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('names the time the change is allowed from when an older process ran until recently', async () => {
    const { ApiError } = await import('@/lib/api');
    patchMock.mockRejectedValueOnce(
      new ApiError(409, {
        error: 'A process older than v0.1.41 ran until recently.',
        code: 'FLEET_BILLING_OLD_PODS_CONNECTED',
        details: {
          reason: 'old_processes',
          oldConnections: 0,
          hosts: [],
          lastOldSeenAt: '2026-10-16T09:50:00.000Z',
          allowedFrom: '2026-10-16T10:00:00.000Z',
          watchCheckedAt: '2026-10-16T09:55:00.000Z',
        },
      }),
    );
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: false }} />);
    fireEvent.click(screen.getByRole('switch', { name: 'fleets.billing.chargeOnAccount' }));
    fireEvent.click(screen.getByRole('button', { name: 'fleets.billing.enable' }));
    const notice = await screen.findByTestId('fleet-billing-upgrade-error');
    expect(notice.textContent).toBe(
      'fleets.billing.oldProcessRecent 2026-10-16T10:00:00.000Z@Europe/Berlin',
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('reads allowedFrom only for an old-release refusal with no process connected now', async () => {
    const { ApiError } = await import('@/lib/api');
    const body = (details: Record<string, unknown>, code = 'FLEET_BILLING_OLD_PODS_CONNECTED') =>
      new ApiError(409, { error: 'x', code, details });
    const at = '2026-10-16T10:00:00.000Z';
    expect(oldProcessAllowedFrom(body({ oldConnections: 0, allowedFrom: at }))).toBe(at);
    expect(oldProcessAllowedFrom(body({ oldConnections: 2, allowedFrom: at }))).toBeNull();
    expect(oldProcessAllowedFrom(body({ oldConnections: 0, allowedFrom: null }))).toBeNull();
    expect(oldProcessAllowedFrom(body({ oldConnections: 0, allowedFrom: 'soon' }))).toBeNull();
    expect(
      oldProcessAllowedFrom(
        body({ oldConnections: 0, allowedFrom: at }, 'FLEET_BILLING_VERSION_CHECK_STALE'),
      ),
    ).toBeNull();
    expect(oldProcessAllowedFrom(new Error('network'))).toBeNull();
  });

  it('shows the stale version check refusal inline with its own message', async () => {
    const { ApiError } = await import('@/lib/api');
    patchMock.mockRejectedValueOnce(
      new ApiError(409, {
        error: "The worker's process version check has not run recently.",
        code: 'FLEET_BILLING_VERSION_CHECK_STALE',
      }),
    );
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountBillingEnabled: true }} />);
    fireEvent.change(screen.getByLabelText('fleets.billing.invoiceTo'), {
      target: { value: 'member' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'fleets.billing.recipientChange' }));
    const notice = await screen.findByTestId('fleet-billing-upgrade-error');
    expect(notice.textContent).toContain('process version check has not run recently');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('disables the recipient select without fleets:write', () => {
    permission.canWrite = false;
    wrap(<FleetBillingTab fleet={{ id: 'flt_1', accountInvoiceRecipient: 'member' }} />);
    const select = screen.getByLabelText<HTMLSelectElement>('fleets.billing.invoiceTo');
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('member');
    expect(screen.getByText('fleets.billing.recipientHelpMember')).toBeTruthy();
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

  it('hides member changes and disables the opt-out for a site-restricted user', async () => {
    permission.allSites = false;
    getMock.mockResolvedValue({ data: [member], total: 1 });
    wrap(<FleetDriversTab fleetId="flt_1" accountBillingEnabled canManageMembers={false} />);

    const toggle = await screen.findByTestId('member-billing-drv_1');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('fleets.membersAllSitesOnly')).toBeTruthy();
    expect(screen.queryByText('fleets.addDriver')).toBeNull();
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

  it('shows that an account driver is invoiced personally', () => {
    wrap(
      <DriverBillingCard
        billing={{
          mode: 'account',
          billingFleet: { id: 'flt_1', name: 'Acme' },
          pricingFleet: null,
          invoicedTo: 'member',
        }}
      />,
    );
    expect(screen.getByTestId('driver-invoiced-to').textContent).toBe(
      'drivers.billing.invoicedToMember',
    );
    expect(screen.getByText('drivers.billing.helpAccountMember')).toBeTruthy();
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
    invoiceDateMode: 'run_date' as const,
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
    expect(screen.getByText('fleets.billingProfile.invoiceDateRunDate')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('fleets.billingProfile.invoiceDate'), {
      target: { value: 'period_end' },
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
        invoiceDateMode: 'period_end',
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
