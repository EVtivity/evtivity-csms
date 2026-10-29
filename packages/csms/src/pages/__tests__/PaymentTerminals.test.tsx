// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal list: the feature-off notice, the rows (pairing, device
// status, SIM), the filters kept in the URL and New Payment Terminal shown
// with paymentTerminals:write only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

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
    authState: { permissions: ['paymentTerminals:read', 'paymentTerminals:write'] },
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
vi.mock('@/components/search-input', () => ({
  SearchInput: ({
    value,
    onDebouncedChange,
    placeholder,
  }: {
    value: string;
    onDebouncedChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input
      aria-label={placeholder}
      value={value}
      onChange={(e) => {
        onDebouncedChange(e.target.value);
      }}
    />
  ),
}));

import { PaymentTerminals } from '@/pages/PaymentTerminals';

const TERMINAL = {
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
  lastSeenAt: '2026-10-29T09:00:00.000Z',
  statusFetchedAt: null,
  offlineSince: null,
  hasDisplay: true,
  simAttached: false,
  createdAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T08:00:00.000Z',
};

let feature = { available: true, providers: ['simulated'], terminalCount: 1 };

function routeGet(url: string): Promise<unknown> {
  if (url === '/v1/payment-terminals/feature') return Promise.resolve(feature);
  if (url.startsWith('/v1/payment-terminals?')) {
    return Promise.resolve({
      data: [
        TERMINAL,
        {
          ...TERMINAL,
          id: 'ptm_2',
          label: null,
          serialNumber: 'SIM-2',
          stationId: null,
          stationOcppId: null,
          status: 'inactive',
          online: false,
          simAttached: true,
        },
      ],
      total: 2,
    });
  }
  if (url.startsWith('/v1/sites?')) {
    return Promise.resolve({ data: [{ id: 'sit_1', name: 'Depot' }], total: 1 });
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function renderPage(path = '/payment-terminals'): void {
  window.history.replaceState(null, '', path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <PaymentTerminals />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  feature = { available: true, providers: ['simulated'], terminalCount: 1 };
  authState.permissions = ['paymentTerminals:read', 'paymentTerminals:write'];
  apiMock.get.mockImplementation(routeGet);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaymentTerminals', () => {
  it('says the feature is off while no provider is set up and no terminal exists', async () => {
    feature = { available: false, providers: [], terminalCount: 0 };
    renderPage();
    expect(await screen.findByText('paymentTerminals.featureOff')).toBeDefined();
    expect(apiMock.get).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/v1\/payment-terminals\?/),
    );
  });

  it('lists the terminals with pairing, status, device status and SIM', async () => {
    renderPage();
    const row = await screen.findByTestId('payment-terminal-row-ptm_1');
    expect(within(row).getByText('Bay 1 reader')).toBeDefined();
    expect(within(row).getByText('CS-001')).toBeDefined();
    expect(within(row).getByText('paymentTerminals.wholeStation')).toBeDefined();
    expect(within(row).getByText('paymentTerminals.online')).toBeDefined();
    expect(within(row).getByText('paymentTerminals.status.active')).toBeDefined();
    const unpaired = screen.getByTestId('payment-terminal-row-ptm_2');
    // A terminal without a label shows its serial number.
    expect(within(unpaired).getByTestId('row-click-target').textContent).toBe('SIM-2');
    expect(within(unpaired).getByText('paymentTerminals.notPaired')).toBeDefined();
    expect(within(unpaired).getByText('paymentTerminals.offline')).toBeDefined();
    expect(within(unpaired).getByText('paymentTerminals.simAttached')).toBeDefined();
  });

  it('fits the desktop page: eight columns, the serial under the model, wrapping cells', async () => {
    renderPage();
    const row = await screen.findByTestId('payment-terminal-row-ptm_1');
    const table = row.closest('table');
    // The table scrolls inside its own container, never the page (ui.md).
    expect(table?.parentElement?.parentElement?.className).toContain('overflow-x-auto');
    expect(within(table as HTMLElement).getAllByRole('columnheader')).toHaveLength(8);
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(8);
    expect(cells[1]?.textContent).toBe('VP6825SIM-1');
    // The site and the last seen time wrap instead of widening the table.
    expect(cells[2]?.className).toContain('whitespace-normal');
    expect(cells[6]?.className).toContain('whitespace-normal');
    expect(within(cells[7] as HTMLElement).getByText('common.no')).toBeDefined();
  });

  it('keeps a filter in the URL and sends it to the list', async () => {
    renderPage();
    await screen.findByTestId('payment-terminal-row-ptm_1');
    const status = screen.getAllByLabelText('paymentTerminals.filters.status')[0];
    if (status == null) throw new Error('no status filter');
    fireEvent.change(status, { target: { value: 'inactive' } });
    await waitFor(() => {
      expect(window.location.search).toContain('status=inactive');
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining('status=inactive'));
    });
  });

  it('reads the filters from the URL', async () => {
    renderPage('/payment-terminals?online=false&siteId=sit_1');
    await screen.findByTestId('payment-terminal-row-ptm_1');
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/payment-terminals\?.*online=false.*siteId=sit_1/),
    );
  });

  it('exports the list with the search and the filters on screen, also for a reader', async () => {
    authState.permissions = ['paymentTerminals:read'];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('id,name\r\n', { status: 200 }));
    const createObjectURL = vi.fn(() => 'blob:terminals');
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    renderPage('/payment-terminals?status=active&siteId=sit_1&search=Bay');
    await screen.findByTestId('payment-terminal-row-ptm_1');
    fireEvent.click(screen.getByRole('button', { name: 'paymentTerminals.exportCsv' }));
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/payment-terminals\/export\?/);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({ search: 'Bay', status: 'active', siteId: 'sit_1' });
    expect(init.credentials).toBe('include');
    fetchMock.mockRestore();
    if (originalCreate != null) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    if (originalRevoke != null) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  });

  it('shows New Payment Terminal with paymentTerminals:write only', async () => {
    renderPage();
    expect(await screen.findByText('paymentTerminals.create')).toBeDefined();
    cleanup();
    authState.permissions = ['paymentTerminals:read'];
    renderPage();
    await screen.findByTestId('payment-terminal-row-ptm_1');
    expect(screen.queryByText('paymentTerminals.create')).toBeNull();
  });
});
