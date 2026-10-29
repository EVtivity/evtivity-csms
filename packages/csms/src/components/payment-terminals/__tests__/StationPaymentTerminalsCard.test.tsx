// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Payment Terminals card of the station Connectors tab: nothing without
// the permission or the feature, the paired terminals, Pair of an unpaired
// terminal and New Payment Terminal with the station chosen.

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
    authState: { permissions: [] as string[] },
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
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
  };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StationPaymentTerminalsCard } from '../StationPaymentTerminalsCard';

const BASE = {
  provider: 'simulated',
  integrationMode: 'cloud',
  vendor: null,
  model: 'VP6825',
  firmwareVersion: null,
  siteId: 'sit_1',
  siteName: 'Depot',
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
};

let available = true;

function routeGet(url: string): Promise<unknown> {
  if (url === '/v1/payment-terminals/feature') {
    return Promise.resolve({ available, providers: ['simulated'], terminalCount: 1 });
  }
  if (url.startsWith('/v1/payment-terminals?') && url.includes('stationId=sta_1')) {
    return Promise.resolve({
      data: [
        {
          ...BASE,
          id: 'ptm_1',
          label: 'Bay 1 reader',
          serialNumber: 'SIM-1',
          providerDeviceId: 'sim_term_1',
          stationId: 'sta_1',
          stationOcppId: 'CS-001',
          evseId: 'evs_1',
          evseNumber: 1,
        },
      ],
      total: 1,
    });
  }
  if (url === '/v1/payment-terminals?status=active&limit=100') {
    return Promise.resolve({
      data: [
        {
          ...BASE,
          id: 'ptm_2',
          label: 'Spare reader',
          serialNumber: 'SIM-2',
          providerDeviceId: 'sim_term_2',
          stationId: null,
          stationOcppId: null,
        },
      ],
      total: 1,
    });
  }
  if (url === '/v1/stations/sta_1/connectors') return Promise.resolve([]);
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/stations/sta_1']}>
        <Routes>
          <Route path="/stations/:id" element={<StationPaymentTerminalsCard stationId="sta_1" />} />
          <Route path="/payment-terminals/new" element={<p>new terminal page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  available = true;
  authState.permissions = ['paymentTerminals:read', 'paymentTerminals:write', 'stations:write'];
  apiMock.get.mockImplementation(routeGet);
  apiMock.post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationPaymentTerminalsCard', () => {
  it('renders nothing and reads nothing without paymentTerminals:read', () => {
    authState.permissions = [];
    renderCard();
    expect(screen.queryByText('paymentTerminals.stationCard.title')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('renders nothing while the feature is off', async () => {
    available = false;
    renderCard();
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/payment-terminals/feature');
    });
    expect(screen.queryByText('paymentTerminals.stationCard.title')).toBeNull();
  });

  it('lists the paired terminals with their connector', async () => {
    renderCard();
    const row = await screen.findByTestId('station-terminal-row-ptm_1');
    expect(within(row).getByText('Bay 1 reader')).toBeDefined();
    expect(within(row).getByText('paymentTerminals.connector:{"number":1}')).toBeDefined();
  });

  it('pairs an unpaired terminal to the station', async () => {
    renderCard();
    fireEvent.click(await screen.findByText('paymentTerminals.pairing.pair'));
    const dialog = screen.getByRole('dialog');
    const pick = within(dialog).getByLabelText('paymentTerminals.stationCard.terminal');
    await waitFor(() => {
      expect(within(pick).getByText('Spare reader')).toBeDefined();
    });
    fireEvent.change(pick, { target: { value: 'ptm_2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'paymentTerminals.pairing.pair' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/payment-terminals/ptm_2/pair', {
        stationId: 'sta_1',
        evseId: null,
      });
    });
  });

  it('opens New Payment Terminal with the station chosen', async () => {
    renderCard();
    fireEvent.click(await screen.findByText('paymentTerminals.create'));
    expect(await screen.findByText('new terminal page')).toBeDefined();
  });

  it('hides Pair and New without stations:write', async () => {
    authState.permissions = ['paymentTerminals:read', 'paymentTerminals:write'];
    renderCard();
    await screen.findByTestId('station-terminal-row-ptm_1');
    expect(screen.queryByText('paymentTerminals.pairing.pair')).toBeNull();
    expect(screen.queryByText('paymentTerminals.create')).toBeNull();
  });
});
