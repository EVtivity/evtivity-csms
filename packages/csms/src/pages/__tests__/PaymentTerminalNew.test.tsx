// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// New Payment Terminal: an all-site user picks an unregistered device of the
// provider account, a site-restricted user types the device ID and names one
// of their sites; a station from the link is paired station-wide.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { apiMock, authState } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), post: vi.fn() },
    authState: { permissions: [] as string[], allSites: true },
  };
});

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
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
    useHasAllSiteAccess: () => authState.allSites,
  };
});

import { PaymentTerminalNew } from '@/pages/PaymentTerminalNew';

function routeGet(url: string): Promise<unknown> {
  if (url === '/v1/payment-terminals/feature') {
    return Promise.resolve({ available: true, providers: ['simulated'], terminalCount: 0 });
  }
  if (url === '/v1/payment-terminals/provider-devices?provider=simulated') {
    return Promise.resolve({
      devices: [
        {
          providerDeviceId: 'sim_term_1',
          serialNumber: 'SIM-1',
          model: 'VP6825',
          online: true,
          registered: true,
        },
        {
          providerDeviceId: 'sim_term_3',
          serialNumber: 'SIM-3',
          model: 'VP7200',
          online: true,
          registered: false,
        },
      ],
    });
  }
  if (url.startsWith('/v1/sites?')) {
    return Promise.resolve({ data: [{ id: 'sit_1', name: 'Depot' }], total: 1 });
  }
  if (url.startsWith('/v1/stations?')) {
    return Promise.resolve({
      data: [{ id: 'sta_250', stationId: 'CS-250', isOnline: true }],
      total: 1,
    });
  }
  // A station past the first page of the station list, named by the link.
  if (url === '/v1/stations/sta_1') return Promise.resolve({ id: 'sta_1', stationId: 'CS-001' });
  if (url === '/v1/stations/sta_250') {
    return Promise.resolve({ id: 'sta_250', stationId: 'CS-250' });
  }
  if (url === '/v1/stations/sta_1/connectors') return Promise.resolve([{ evseId: 1 }]);
  if (url === '/v1/stations/sta_250/connectors') {
    return Promise.resolve([{ id: 'evs_2', evseId: 2 }]);
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function renderPage(path = '/payment-terminals/new'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/payment-terminals/new" element={<PaymentTerminalNew />} />
          <Route path="/payment-terminals/:id" element={<p>terminal page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authState.permissions = ['paymentTerminals:read', 'paymentTerminals:write', 'stations:write'];
  authState.allSites = true;
  apiMock.get.mockImplementation(routeGet);
  apiMock.post.mockResolvedValue({ id: 'ptm_9' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaymentTerminalNew', () => {
  it('offers only unregistered devices and fills the model and serial number', async () => {
    renderPage();
    const device = await screen.findByLabelText('paymentTerminals.new.device');
    await waitFor(() => {
      expect(within(device).getAllByRole('option')).toHaveLength(2);
    });
    expect(within(device).queryByText(/sim_term_1/)).toBeNull();
    fireEvent.change(device, { target: { value: 'sim_term_3' } });
    expect(screen.getByLabelText('paymentTerminals.fields.model')).toHaveProperty(
      'value',
      'VP7200',
    );
    expect(screen.getByLabelText('paymentTerminals.fields.serialNumber')).toHaveProperty(
      'value',
      'SIM-3',
    );
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals', {
        provider: 'simulated',
        providerDeviceId: 'sim_term_3',
        model: 'VP7200',
        serialNumber: 'SIM-3',
      });
    });
    expect(await screen.findByText('terminal page')).toBeDefined();
  });

  it('pairs the station from the link station-wide', async () => {
    renderPage('/payment-terminals/new?stationId=sta_1');
    const device = await screen.findByLabelText('paymentTerminals.new.device');
    await waitFor(() => {
      expect(within(device).getAllByRole('option')).toHaveLength(2);
    });
    fireEvent.change(device, { target: { value: 'sim_term_3' } });
    expect(await screen.findByLabelText('paymentTerminals.pairing.connector')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        '/v1/payment-terminals',
        expect.objectContaining({ stationId: 'sta_1', evseId: null }),
      );
    });
  });

  it('loads the station of the link by its ID, never from a page of the station list', async () => {
    renderPage('/payment-terminals/new?stationId=sta_1');
    const station = await screen.findByLabelText('paymentTerminals.pairing.station');
    await waitFor(() => {
      expect(station).toHaveProperty('value', 'CS-001');
    });
    expect(apiMock.get).toHaveBeenCalledWith('/v1/stations/sta_1');
    expect(apiMock.get).not.toHaveBeenCalledWith('/v1/stations?limit=100');
  });

  it('searches the station and pairs the picked connector', async () => {
    renderPage();
    const device = await screen.findByLabelText('paymentTerminals.new.device');
    await waitFor(() => {
      expect(within(device).getAllByRole('option')).toHaveLength(2);
    });
    fireEvent.change(device, { target: { value: 'sim_term_3' } });
    fireEvent.change(screen.getByLabelText('paymentTerminals.pairing.station'), {
      target: { value: 'CS-25' },
    });
    fireEvent.click(await screen.findByText('CS-250', {}, { timeout: 2000 }));
    expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining('search=CS-25'));
    const connector = await screen.findByLabelText('paymentTerminals.pairing.connector');
    await waitFor(() => {
      expect(within(connector).getAllByRole('option')).toHaveLength(2);
    });
    fireEvent.change(connector, { target: { value: 'evs_2' } });
    expect(screen.getByLabelText('paymentTerminals.pairing.station')).toHaveProperty(
      'value',
      'CS-250',
    );
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        '/v1/payment-terminals',
        expect.objectContaining({ stationId: 'sta_250', evseId: 'evs_2' }),
      );
    });
  });

  it('asks a site-restricted user for the device ID and one of their sites', async () => {
    authState.allSites = false;
    renderPage();
    const device = await screen.findByLabelText('paymentTerminals.new.device');
    expect(device.tagName).toBe('INPUT');
    expect(apiMock.get).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/payment-terminals/provider-devices'),
    );
    fireEvent.change(device, { target: { value: 'sim_term_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    expect(await screen.findByText('validation.selectRequired')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
    const site = screen.getByLabelText('paymentTerminals.fields.site');
    await waitFor(() => {
      expect(within(site).getByText('Depot')).toBeDefined();
    });
    fireEvent.change(site, { target: { value: 'sit_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals', {
        provider: 'simulated',
        providerDeviceId: 'sim_term_2',
        siteId: 'sit_1',
      });
    });
  });

  it('refuses a device ID with spaces', async () => {
    authState.allSites = false;
    renderPage();
    fireEvent.change(await screen.findByLabelText('paymentTerminals.new.device'), {
      target: { value: 'sim term' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.new.submit' }));
    expect(await screen.findByText('paymentTerminals.new.deviceIdInvalid')).toBeDefined();
  });

  it('shows no pairing fields without stations:write', async () => {
    authState.permissions = ['paymentTerminals:read', 'paymentTerminals:write'];
    renderPage('/payment-terminals/new?stationId=sta_1');
    expect(await screen.findByText('paymentTerminals.new.pairingNeedsPermission')).toBeDefined();
    expect(screen.queryByLabelText('paymentTerminals.pairing.station')).toBeNull();
  });
});
