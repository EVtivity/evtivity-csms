// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';

const { apiMock, authState } = vi.hoisted(() => {
  // The theme store reads matchMedia when the app modules load; jsdom has none.
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
    authState: { permissions: ['sims:read', 'sims:write'], allSites: true },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
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
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
    useHasAllSiteAccess: () => authState.allSites,
    useHasCompanyWidePermission: (perm: string) =>
      authState.allSites && authState.permissions.includes(perm),
  };
});

import { Sims } from '@/pages/Sims';
import { simExportQuery, simListParams } from '@/components/sims/sim-filters';

const SIM = {
  id: 'sim_1',
  iccid: '8944500102198304826',
  imsi: '234500000000001',
  label: 'Depot spare',
  notes: null,
  provider: 'hologram',
  providerRef: '123',
  status: 'inactive',
  deactivatedAt: null,
  deactivatedBy: null,
  lastStatus: {
    state: 'suspended',
    providerState: 'PAUSED',
    inSession: null,
    openSessionBeganAt: null,
    apn: null,
    profileName: null,
    lastSessionAt: null,
    usage: null,
  },
  statusFetchedAt: '2026-10-20T10:00:00.000Z',
  lastFetchedAt: '2026-10-21T10:00:00.000Z',
  lookupMissedAt: null,
  lookupMissReason: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  attachment: {
    id: 7,
    stationId: 'sta_1',
    stationOcppId: 'CS-1',
    siteId: 'sit_1',
    siteName: 'North',
    paymentTerminalId: null,
    source: 'entered',
    attachedAt: '2026-10-02T10:00:00.000Z',
    confirmed: false,
    confirmedAt: null,
  },
};

let lastSearch = '';
let lastPath = '';
function LocationProbe(): null {
  const location = useLocation();
  lastSearch = location.search;
  lastPath = location.pathname;
  return null;
}

function renderPage(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The app's BrowserRouter: the page reads the URL as the browser holds it.
  window.history.replaceState(null, '', url);
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Sims />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function listUrls(): string[] {
  return apiMock.get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/v1/sims?'));
}

function answerList(list: () => Promise<unknown>, simEnabled = true): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/portal/features') return Promise.resolve({ simEnabled });
    return url.startsWith('/v1/sims?') ? list() : Promise.resolve({ data: [], total: 0 });
  });
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  authState.permissions = ['sims:read', 'sims:write'];
  authState.allSites = true;
  lastSearch = '';
  lastPath = '';
});

afterEach(() => {
  cleanup();
});

describe('SIM filters', () => {
  it('reads the list filters from the URL and leaves out empty and unknown ones', () => {
    const params = new URLSearchParams(
      'provider=hologram&attachment=unconfirmed&status=active&state=&stationId=sta_1&foo=1',
    );
    expect(simListParams(params)).toEqual({
      provider: 'hologram',
      attachment: 'unconfirmed',
      status: 'active',
      stationId: 'sta_1',
    });
  });

  it('builds the export query from the search and the filters on screen', () => {
    expect(simExportQuery('8944', { provider: 'hologram', state: 'active' })).toBe(
      'search=8944&provider=hologram&state=active',
    );
    expect(simExportQuery('', {})).toBe('');
  });
});

describe('SIMs list', () => {
  it('shows the loading logo while the list loads', async () => {
    answerList(() => new Promise(() => undefined));
    renderPage('/sims');
    await waitFor(() => {
      expect(listUrls().length).toBe(1);
    });
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('says the SIM features are off and lists nothing while they are off', async () => {
    answerList(() => Promise.resolve({ data: [SIM], total: 1 }), false);
    renderPage('/sims');
    expect(await screen.findByText('sims.featureOff')).toBeDefined();
    expect(listUrls()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'sites.exportCsv' })).toBeNull();
  });

  it('renders a row with the CSMS status apart from the provider status, and opens the SIM', async () => {
    answerList(() => Promise.resolve({ data: [SIM], total: 1 }));
    renderPage('/sims');
    const row = await screen.findByTestId('sim-row-sim_1');
    expect(within(row).getByText('8944500102198304826')).toBeDefined();
    expect(within(row).getByText('Depot spare')).toBeDefined();
    expect(within(row).getByText('Hologram')).toBeDefined();
    expect(within(row).getByText('sims.csmsStatus.inactive')).toBeDefined();
    expect(within(row).getByText('stations.sim.state.suspended')).toBeDefined();
    expect(within(row).getByRole('link', { name: 'CS-1' }).getAttribute('href')).toBe(
      '/stations/sta_1',
    );
    expect(screen.getByText('sims.columns.csmsStatus')).toBeDefined();
    expect(screen.getByText('sims.columns.providerStatus')).toBeDefined();
    const targets = within(row).getAllByTestId('row-click-target');
    expect(targets).toHaveLength(1);
    expect(within(targets[0] as HTMLElement).queryByRole('link')).toBeNull();
    fireEvent.click(targets[0] as HTMLElement);
    expect(lastPath).toBe('/sims/sim_1');
  });

  it('shows the centered empty text', async () => {
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims');
    const empty = await screen.findByText('sims.noSims');
    expect(empty.className).toContain('text-center');
  });

  it('shows the load error with a Retry that loads the list again', async () => {
    answerList(() => Promise.reject(new Error('down')));
    renderPage('/sims');
    fireEvent.click(await screen.findByRole('button', { name: 'common.retry' }));
    expect(screen.getByText('common.loadError')).toBeDefined();
    await waitFor(() => {
      expect(listUrls().length).toBe(2);
    });
  });

  it('reads the filters from the URL and writes a changed one back', async () => {
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims?provider=hologram&status=inactive&search=8944');
    await waitFor(() => {
      expect(listUrls()).toContain(
        '/v1/sims?page=1&limit=10&search=8944&provider=hologram&status=inactive',
      );
    });
    fireEvent.change(screen.getAllByLabelText('sims.filters.providerStatus')[0] as HTMLElement, {
      target: { value: 'suspended' },
    });
    await waitFor(() => {
      expect(lastSearch).toContain('state=suspended');
    });
    expect(lastSearch).toContain('provider=hologram');
    await waitFor(() => {
      expect(listUrls()).toContain(
        '/v1/sims?page=1&limit=10&search=8944&provider=hologram&status=inactive&state=suspended',
      );
    });
  });

  it('keeps the search in the URL when a filter changes right after the debounced search', async () => {
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims');
    await screen.findByText('sims.noSims');
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getAllByPlaceholderText('sims.searchPlaceholder')[0] as HTMLElement, {
        target: { value: '8944' },
      });
      // The debounced search and a filter change land before the page renders the new URL.
      act(() => {
        vi.advanceTimersByTime(300);
        fireEvent.change(
          screen.getAllByLabelText('sims.filters.providerStatus')[0] as HTMLElement,
          {
            target: { value: 'suspended' },
          },
        );
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      expect(lastSearch).toContain('state=suspended');
    });
    expect(lastSearch).toContain('search=8944');
    expect(window.location.search).toContain('search=8944');
  });

  it('shows the ICCID as the row link without a monospace font', async () => {
    answerList(() =>
      Promise.resolve({
        data: [SIM],
        total: 1,
      }),
    );
    renderPage('/sims');
    const cell = (await screen.findAllByTestId('row-click-target'))[0] as HTMLElement;
    expect(cell.className).toContain('font-medium');
    expect(cell.className).toContain('text-link');
    expect(cell.className).not.toContain('font-mono');
  });

  it('shows Import CSV, Download Template and Export CSV, and no Export All', async () => {
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims');
    await screen.findByText('sims.noSims');
    expect(screen.getByRole('button', { name: 'sites.importCsv' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'sims.downloadTemplate' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'sites.exportCsv' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /exportAll/i })).toBeNull();
  });

  it('hides Import CSV and Download Template without sims:write', async () => {
    authState.permissions = ['sims:read'];
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims');
    await screen.findByText('sims.noSims');
    expect(screen.queryByRole('button', { name: 'sites.importCsv' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sims.downloadTemplate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sites.exportCsv' })).toBeDefined();
  });

  it('hides Import CSV and Download Template without access to every site', async () => {
    authState.allSites = false;
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims');
    await screen.findByText('sims.noSims');
    expect(screen.queryByRole('button', { name: 'sites.importCsv' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sims.downloadTemplate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sites.exportCsv' })).toBeDefined();
  });

  it('exports the list with the filters on screen', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['x'])),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }));
    URL.revokeObjectURL = () => undefined;
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    renderPage('/sims?attachment=unattached&search=89');
    await screen.findByText('sims.noSims');
    fireEvent.click(screen.getByRole('button', { name: 'sites.exportCsv' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/v1\/sims\/export\?search=89&attachment=unattached$/,
    );
  });

  it('imports the CSV rows through the shared dialog', async () => {
    answerList(() => Promise.resolve({ data: [], total: 0 }));
    apiMock.post.mockResolvedValue({ created: 1, updated: 0, attached: 1, errors: [] });
    renderPage('/sims');
    await screen.findByText('sims.noSims');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(
      ['iccid,imsi,label,notes,stationId\n8944500102198304826,,Spare,,CS-1\n'],
      'sims.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('sims.importConfirmTitle')).toBeDefined();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sites.importCsv' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/import', {
        rows: [
          {
            iccid: '8944500102198304826',
            imsi: undefined,
            label: 'Spare',
            notes: undefined,
            stationId: 'CS-1',
          },
        ],
        updateExisting: false,
      });
    });
    expect(await screen.findByText('sites.importResults')).toBeDefined();
  });
});
