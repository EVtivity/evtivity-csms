// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal page: the header, the Details tab (no-screen note,
// Deactivate, Delete refused with payments, Pair and Unpair, Start Test
// Payment), the Payments tab (Void of the open payment, session and payment
// links), the SIM tab (attach and detach) and the History tab, each write
// shown only with the permissions its route needs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/lib/api';

const { apiMock, authState, toastMock } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    authState: {
      permissions: [] as string[],
      allSites: true,
    },
    toastMock: vi.fn(),
  };
});

const ALL_PERMISSIONS = [
  'paymentTerminals:read',
  'paymentTerminals:write',
  'stations:write',
  'payments:read',
  'payments:write',
  'sims:read',
  'sims:write',
  'audit:read',
];

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
    useHasAllSiteAccess: () => authState.allSites,
  };
});
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'USD', isError: false, refetch: vi.fn() }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/EntityHistoryTab', () => ({
  EntityHistoryTab: (props: { entityType: string; entityId: string | null }) => (
    <div data-testid="entity-history" data-type={props.entityType} data-id={props.entityId} />
  ),
}));

import { PaymentTerminalDetail } from '@/pages/PaymentTerminalDetail';

function terminalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ptm_1',
    label: 'Bay 1 reader',
    provider: 'simulated',
    integrationMode: 'cloud',
    providerDeviceId: 'sim_term_1',
    vendor: null,
    model: 'VP6825',
    serialNumber: 'SIM-1',
    firmwareVersion: 'sim-1.0.0',
    siteId: 'sit_1',
    siteName: 'Depot',
    stationId: 'sta_1',
    stationOcppId: 'CS-001',
    evseId: null,
    evseNumber: null,
    status: 'active',
    online: true,
    lastSeenAt: null,
    statusFetchedAt: null,
    offlineSince: null,
    hasDisplay: true,
    simAttached: false,
    createdAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
    ...overrides,
  };
}

const TRANSACTIONS = {
  data: [
    {
      id: 'ptx_2',
      paymentTerminalId: 'ptm_1',
      state: 'authorized',
      currency: 'USD',
      requestedCents: 5000,
      authorizedCents: 5000,
      capturedCents: null,
      refundedCents: 0,
      cardLast4: '4242',
      cardBrand: 'visa',
      declineCode: null,
      failureReason: null,
      siteId: 'sit_1',
      stationId: 'sta_1',
      evseNumber: 0,
      sessionId: null,
      paymentRecordId: null,
      requestedAt: '2026-10-29T10:00:00.000Z',
      authorizedAt: '2026-10-29T10:00:05.000Z',
      capturedAt: null,
      voidedAt: null,
    },
    {
      id: 'ptx_1',
      paymentTerminalId: 'ptm_1',
      state: 'captured',
      currency: 'USD',
      requestedCents: 5000,
      authorizedCents: 5000,
      capturedCents: 1234,
      refundedCents: 0,
      cardLast4: '4242',
      cardBrand: 'visa',
      declineCode: null,
      failureReason: null,
      siteId: 'sit_1',
      stationId: 'sta_1',
      evseNumber: 1,
      sessionId: 'ses_1',
      paymentRecordId: 7,
      requestedAt: '2026-10-28T10:00:00.000Z',
      authorizedAt: '2026-10-28T10:00:05.000Z',
      capturedAt: '2026-10-28T11:00:00.000Z',
      voidedAt: null,
    },
  ],
  total: 2,
};

let terminal = terminalFixture();

function routeGet(url: string): Promise<unknown> {
  if (url === '/v1/payment-terminals/ptm_1') return Promise.resolve(terminal);
  if (url.startsWith('/v1/payment-terminals/ptm_1/transactions')) {
    return Promise.resolve(TRANSACTIONS);
  }
  if (url.startsWith('/v1/stations?')) {
    return Promise.resolve({ data: [{ id: 'sta_1', stationId: 'CS-001' }], total: 1 });
  }
  if (url === '/v1/stations/sta_1') return Promise.resolve({ id: 'sta_1', stationId: 'CS-001' });
  if (url === '/v1/stations/sta_1/connectors') {
    return Promise.resolve([{ id: 'evs_1', evseId: 1, retiredAt: null }]);
  }
  if (url.startsWith('/v1/sites?')) {
    return Promise.resolve({ data: [{ id: 'sit_1', name: 'Depot' }], total: 1 });
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function renderPage(path = '/payment-terminals/ptm_1'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/payment-terminals/:id" element={<PaymentTerminalDetail />} />
          <Route path="/payment-terminals" element={<p>terminal list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

beforeEach(() => {
  terminal = terminalFixture();
  authState.permissions = [...ALL_PERMISSIONS];
  authState.allSites = true;
  apiMock.get.mockImplementation(routeGet);
  apiMock.post.mockResolvedValue({});
  apiMock.patch.mockResolvedValue(terminal);
  apiMock.delete.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaymentTerminalDetail header and tabs', () => {
  it('shows the name, the status and every tab for a user with all permissions', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Bay 1 reader' })).toBeDefined();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'common.details',
      'paymentTerminals.detail.tabs.payments',
      'paymentTerminals.detail.tabs.sim',
      'audit.history',
    ]);
  });

  it('hides the Payments tab without payments:read and the History tab without audit:read', async () => {
    authState.permissions = ['paymentTerminals:read'];
    renderPage();
    await screen.findByRole('heading', { name: 'Bay 1 reader' });
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['common.details', 'paymentTerminals.detail.tabs.sim']);
    // A reader gets no write controls.
    expect(screen.queryByText('paymentTerminals.detail.deactivate')).toBeNull();
    expect(screen.queryByText('paymentTerminals.pairing.change')).toBeNull();
    expect(screen.queryByText('paymentTerminals.testPayment.title')).toBeNull();
  });

  it('says the terminal is not found on a 404', async () => {
    apiMock.get.mockImplementation((url: string) =>
      url === '/v1/payment-terminals/ptm_1'
        ? Promise.reject(new ApiError(404, { code: 'PAYMENT_TERMINAL_NOT_FOUND' }))
        : routeGet(url),
    );
    renderPage();
    expect(await screen.findByText('paymentTerminals.detail.notFound')).toBeDefined();
  });

  it('opens the History tab with the payment terminal entity', async () => {
    renderPage('/payment-terminals/ptm_1?tab=history');
    const history = await screen.findByTestId('entity-history');
    expect(history.getAttribute('data-type')).toBe('payment_terminal');
    expect(history.getAttribute('data-id')).toBe('ptm_1');
  });
});

describe('PaymentTerminalDetail Details tab', () => {
  it('notes that a model without a screen uses the station display', async () => {
    terminal = terminalFixture({ model: 'VP7200', hasDisplay: false });
    renderPage();
    expect(await screen.findByTestId('terminal-no-display')).toBeDefined();
  });

  it('shows no screen note for a model with a screen', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Bay 1 reader' });
    expect(screen.queryByTestId('terminal-no-display')).toBeNull();
  });

  it('deactivates after the confirmation', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('paymentTerminals.detail.deactivate'));
    fireEvent.click(within(dialog()).getByRole('button', { name: /detail\.deactivate/ }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/status', {
        status: 'inactive',
      });
    });
  });

  it('keeps the delete dialog open with the reason when the terminal has payments', async () => {
    apiMock.delete.mockRejectedValue(
      new ApiError(409, { code: 'PAYMENT_TERMINAL_HAS_TRANSACTIONS', error: 'has payments' }),
    );
    renderPage();
    fireEvent.click(await screen.findByText('paymentTerminals.detail.delete'));
    fireEvent.click(within(dialog()).getByRole('button', { name: /detail\.delete/ }));
    expect(await screen.findByTestId('terminal-delete-error')).toBeDefined();
    // The test t() returns the key, so the message falls back to the API text.
    expect(screen.getByTestId('terminal-delete-error').textContent).toBe('has payments');
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('pairs to the whole station by default (evseId null) and to a chosen connector', async () => {
    terminal = terminalFixture({ stationId: null, stationOcppId: null });
    renderPage();
    fireEvent.click(await screen.findByText('paymentTerminals.pairing.pair'));
    fireEvent.change(within(dialog()).getByLabelText('paymentTerminals.pairing.station'), {
      target: { value: 'CS-00' },
    });
    fireEvent.click(await within(dialog()).findByText('CS-001', {}, { timeout: 2000 }));
    expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining('search=CS-00'));
    const connector = await within(dialog()).findByLabelText('paymentTerminals.pairing.connector');
    await waitFor(() => {
      expect(within(connector).getByText('paymentTerminals.connector:{"number":1}')).toBeDefined();
    });
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'paymentTerminals.pairing.pair' }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/pair', {
        stationId: 'sta_1',
        evseId: null,
      });
    });
  });

  it('refuses to pair without a station', async () => {
    terminal = terminalFixture({ stationId: null, stationOcppId: null });
    renderPage();
    fireEvent.click(await screen.findByText('paymentTerminals.pairing.pair'));
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'paymentTerminals.pairing.pair' }),
    );
    expect(await within(dialog()).findByText('validation.selectRequired')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('unpairs after the confirmation', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('paymentTerminals.pairing.unpair'));
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'paymentTerminals.pairing.unpair' }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/unpair', {});
    });
  });

  it('hides Pair without stations:write', async () => {
    authState.permissions = ALL_PERMISSIONS.filter((p) => p !== 'stations:write');
    renderPage();
    await screen.findByRole('heading', { name: 'Bay 1 reader' });
    expect(screen.queryByText('paymentTerminals.pairing.change')).toBeNull();
    expect(screen.queryByText('paymentTerminals.pairing.unpair')).toBeNull();
  });

  it('starts a test payment with the amount in cents and the receipt email', async () => {
    apiMock.post.mockResolvedValue({
      transaction: TRANSACTIONS.data[0],
      chargingStarted: true,
      startError: null,
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText(/testPayment\.amount/), {
      target: { value: '12.50' },
    });
    fireEvent.change(screen.getByLabelText('paymentTerminals.testPayment.receiptEmail'), {
      target: { value: 'driver@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.testPayment.start' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/payments', {
        amountCents: 1250,
        receiptEmail: 'driver@example.com',
      });
    });
    expect(await screen.findByText('paymentTerminals.testPayment.chargingStarted')).toBeDefined();
  });

  it('shows why charging did not start', async () => {
    apiMock.post.mockResolvedValue({
      transaction: { ...TRANSACTIONS.data[0], state: 'voided' },
      chargingStarted: false,
      startError: 'STATION_OFFLINE',
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'paymentTerminals.testPayment.start' }),
    );
    expect(
      await screen.findByText(/paymentTerminals\.testPayment\.chargingNotStarted/),
    ).toBeDefined();
  });

  it('starts no test payment while the terminal is inactive', async () => {
    terminal = terminalFixture({ status: 'inactive' });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'paymentTerminals.testPayment.start' }),
    );
    expect(await screen.findByText('paymentTerminals.testPayment.inactive')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('hides the test payment without payments:write', async () => {
    authState.permissions = ALL_PERMISSIONS.filter((p) => p !== 'payments:write');
    renderPage();
    await screen.findByRole('heading', { name: 'Bay 1 reader' });
    expect(screen.queryByText('paymentTerminals.testPayment.title')).toBeNull();
  });

  it('saves the edited label', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('paymentTerminals.fields.label'), {
      target: { value: 'Bay 2 reader' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1', {
        label: 'Bay 2 reader',
        vendor: null,
        model: 'VP6825',
        serialNumber: 'SIM-1',
      });
    });
  });
});

describe('PaymentTerminalDetail Payments tab', () => {
  it('lists the payments with the session and payment links', async () => {
    renderPage('/payment-terminals/ptm_1?tab=payments');
    const row = await screen.findByTestId('terminal-payment-row-ptx_1');
    expect(
      within(row).getByText('paymentTerminals.payments.openSession').getAttribute('href'),
    ).toBe('/sessions/ses_1');
    expect(
      within(row).getByText('paymentTerminals.payments.openPayment').getAttribute('href'),
    ).toBe('/sessions/ses_1?tab=payment');
  });

  it('voids the open payment after the confirmation', async () => {
    renderPage('/payment-terminals/ptm_1?tab=payments');
    const notice = await screen.findByTestId('terminal-open-payment');
    fireEvent.click(within(notice).getByText('paymentTerminals.payments.void'));
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'paymentTerminals.payments.void' }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminal-transactions/ptx_2/void', {});
    });
  });

  it('offers no void without payments:write', async () => {
    authState.permissions = ALL_PERMISSIONS.filter((p) => p !== 'payments:write');
    renderPage('/payment-terminals/ptm_1?tab=payments');
    const notice = await screen.findByTestId('terminal-open-payment');
    expect(within(notice).queryByText('paymentTerminals.payments.void')).toBeNull();
  });
});

describe('PaymentTerminalDetail SIM tab', () => {
  it('attaches a SIM by its ICCID', async () => {
    renderPage('/payment-terminals/ptm_1?tab=sim');
    fireEvent.change(await screen.findByLabelText('paymentTerminals.sim.iccid'), {
      target: { value: '8901260000000000017' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.sim.attach' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/sim', {
        iccid: '8901260000000000017',
      });
    });
  });

  it('refuses an ICCID that is not valid', async () => {
    renderPage('/payment-terminals/ptm_1?tab=sim');
    fireEvent.change(await screen.findByLabelText('paymentTerminals.sim.iccid'), {
      target: { value: '1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.sim.attach' }));
    expect(await screen.findByText('paymentTerminals.sim.iccidInvalid')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('detaches an attached SIM after the confirmation', async () => {
    terminal = terminalFixture({ simAttached: true });
    renderPage('/payment-terminals/ptm_1?tab=sim');
    expect(await screen.findByTestId('terminal-sim-attached')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.sim.detach' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'paymentTerminals.sim.detach' }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/payment-terminals/ptm_1/sim');
    });
  });

  it('offers no SIM change without sims:write', async () => {
    authState.permissions = ALL_PERMISSIONS.filter((p) => p !== 'sims:write');
    renderPage('/payment-terminals/ptm_1?tab=sim');
    expect(await screen.findByTestId('terminal-sim-none')).toBeDefined();
    expect(screen.queryByLabelText('paymentTerminals.sim.iccid')).toBeNull();
  });
});
