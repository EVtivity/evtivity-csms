// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  // The theme store reads matchMedia when the app modules load; jsdom has none.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return { apiMock: { get: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['value'] === 'string' ? `${key}:${opts['value']}` : key,
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
vi.mock('@/hooks/use-column-visibility', () => ({
  useColumnVisibility: () => ({ visibility: {}, setVisibility: () => undefined }),
}));
vi.mock('@/components/ElectricityCostNotices', () => ({
  RecalculateElectricityCostAction: () => null,
}));

import { Sessions } from '@/pages/Sessions';
import { formatCents } from '@/lib/formatting';

const SESSION = {
  id: 'ses_1',
  stationId: 'sta_1',
  stationName: 'CS-1',
  siteName: null,
  driverId: null,
  driverName: null,
  transactionId: 'tx-1',
  status: 'faulted',
  startedAt: '2026-10-14T10:00:00.000Z',
  endedAt: '2026-10-14T11:00:00.000Z',
  idleStartedAt: null,
  energyDeliveredWh: 1000,
  currentCostCents: 300,
  finalCostCents: null,
  currency: 'USD',
  freeVend: false,
  co2AvoidedKg: null,
};

let lastSearch = '';
function LocationProbe(): null {
  lastSearch = useLocation().search;
  return null;
}

function renderPage(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/sessions"
            element={
              <>
                <Sessions />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function listUrls(): string[] {
  return apiMock.get.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/v1/sessions?'));
}

beforeEach(() => {
  apiMock.get.mockReset();
  lastSearch = '';
});

afterEach(() => {
  cleanup();
});

describe('Sessions list', () => {
  it('shows the translated status and a faulted session at 0, not its running cost', async () => {
    apiMock.get.mockImplementation((url: string) =>
      url.startsWith('/v1/sessions?')
        ? Promise.resolve({ data: [SESSION], total: 1 })
        : Promise.resolve({ data: [], total: 0 }),
    );
    renderPage('/sessions');
    const row = await screen.findByTestId('session-row-ses_1');
    expect(within(row).getByText('status.faulted')).toBeDefined();
    expect(within(row).getByText(formatCents(0, 'USD'))).toBeDefined();
    expect(within(row).queryByText(formatCents(300, 'USD'))).toBeNull();
  });

  it('shows the load error with a Retry that loads the list again', async () => {
    apiMock.get.mockImplementation((url: string) =>
      url.startsWith('/v1/sessions?')
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ data: [], total: 0 }),
    );
    renderPage('/sessions');
    fireEvent.click(await screen.findByRole('button', { name: 'common.retry' }));
    expect(screen.getByText('common.loadError')).toBeDefined();
    await waitFor(() => {
      expect(listUrls().length).toBe(2);
    });
  });

  it('reads the filters from the URL and writes a changed one back', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/v1/sites?limit=100')
        return Promise.resolve({ data: [{ id: 'sit_1', name: 'North' }], total: 1 });
      return Promise.resolve({ data: [], total: 0 });
    });
    renderPage('/sessions?siteId=sit_1&status=completed');
    await waitFor(() => {
      expect(listUrls()).toContain('/v1/sessions?page=1&limit=10&siteId=sit_1&status=completed');
    });
    fireEvent.change(screen.getAllByLabelText('common.status')[0] as HTMLElement, {
      target: { value: 'faulted' },
    });
    await waitFor(() => {
      expect(lastSearch).toContain('status=faulted');
    });
    expect(lastSearch).toContain('siteId=sit_1');
    await waitFor(() => {
      expect(listUrls()).toContain('/v1/sessions?page=1&limit=10&siteId=sit_1&status=faulted');
    });
  });

  it('loads a selected site that is not in the first 100 by id, so the filter shows it', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/v1/sites?limit=100')
        return Promise.resolve({ data: [{ id: 'sit_1', name: 'North' }], total: 150 });
      if (url === '/v1/sites/sit_150') return Promise.resolve({ id: 'sit_150', name: 'Far' });
      return Promise.resolve({ data: [], total: 0 });
    });
    renderPage('/sessions?siteId=sit_150');
    expect((await screen.findAllByRole('option', { name: 'Far' })).length).toBeGreaterThan(0);
    const select = screen.getAllByLabelText('sites.title')[0] as HTMLSelectElement;
    expect(select.value).toBe('sit_150');
  });
});
