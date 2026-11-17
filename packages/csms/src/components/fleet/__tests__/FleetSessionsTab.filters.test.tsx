// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  cards: true,
  sessions: true,
  download: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/auth', () => ({
  useIsFleetUser: () => false,
  useHasPermission: (p: string) =>
    p === 'fleetCards:read' ? h.cards : p === 'sessions:read' ? h.sessions : true,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: h.get } }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://api' }));
vi.mock('@/lib/csv-download', () => ({ downloadApiFile: h.download }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/hooks/use-charging-point-path', () => ({
  useChargingPointPath: () => () => '',
}));

import { FleetSessionsTab } from '../FleetSessionsTab';

function sessionUrls(): string[] {
  return h.get.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/v1/fleets/flt_1/sessions?'));
}

function renderTab(path = '/fleets/flt_1'): void {
  h.get.mockImplementation((url: string) => {
    if (url.includes('/drivers?')) {
      return Promise.resolve({
        data: [{ id: 'drv_000000000001', firstName: 'Ana', lastName: 'Lopez' }],
        total: 1,
      });
    }
    if (url.includes('/cards?')) {
      return Promise.resolve({
        data: [{ id: 'dtk_000000000001', idToken: 'AB12', label: 'Van 12' }],
        total: 1,
      });
    }
    return Promise.resolve({ data: [], total: 0 });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/fleets/:id" element={<FleetSessionsTab fleetId="flt_1" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.cards = true;
  h.sessions = true;
  h.download.mockClear();
});

describe('FleetSessionsTab filters', () => {
  it('sends the picked days as the start of the first and the end of the last day', async () => {
    renderTab('/fleets/flt_1?from=2026-11-01&to=2026-11-10');
    await waitFor(() => {
      expect(sessionUrls().length).toBeGreaterThan(0);
    });
    const params = new URL(`http://x${sessionUrls()[0] ?? ''}`).searchParams;
    expect(params.get('from')).toBe(new Date('2026-11-01T00:00:00').toISOString());
    expect(params.get('to')).toBe(new Date('2026-11-10T23:59:59.999').toISOString());
  });

  it('lists the sessions of a picked member, searching members who left too', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText('fleets.cards.searchMembers'), {
      target: { value: 'Ana' },
    });
    fireEvent.click(await screen.findByText('Ana Lopez'));
    await waitFor(() => {
      expect(sessionUrls().some((url) => url.includes('driverId=drv_000000000001'))).toBe(true);
    });
    const memberSearch = h.get.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/drivers?'));
    expect(memberSearch).not.toContain('active=true');
  });

  it('lists the sessions of a picked fleet RFID card', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText('fleets.sessionFilters.searchCards'), {
      target: { value: 'Van' },
    });
    fireEvent.click(await screen.findByText('Van 12 (AB12)'));
    await waitFor(() => {
      expect(sessionUrls().some((url) => url.includes('tokenId=dtk_000000000001'))).toBe(true);
    });
  });

  it('says how sessions appear while the fleet has none, and that filters match none', async () => {
    renderTab();
    expect(await screen.findByText('fleets.sessionsEmpty.none')).toBeTruthy();
    cleanup();
    renderTab('/fleets/flt_1?from=2026-11-01&to=2026-11-10');
    expect(await screen.findByText('fleets.sessionsEmpty.filtered')).toBeTruthy();
  });

  it('offers no card filter without the fleet card permission', () => {
    h.cards = false;
    renderTab();
    expect(screen.queryByLabelText('fleets.sessionFilters.searchCards')).toBeNull();
  });

  it('exports with the filters on screen', () => {
    renderTab('/fleets/flt_1?from=2026-11-01&to=2026-11-10');
    fireEvent.click(screen.getByRole('button', { name: 'sites.exportCsv' }));
    expect(h.download).toHaveBeenCalledTimes(1);
    const [url, name] = h.download.mock.calls[0] as unknown as [string, string];
    expect(name).toBe('fleet-sessions.csv');
    expect(url.startsWith('http://api/v1/fleets/flt_1/sessions/export?')).toBe(true);
    expect(new URL(url).searchParams.get('from')).toBe(
      new Date('2026-11-01T00:00:00').toISOString(),
    );
  });

  it('offers no export without sessions:read', () => {
    h.sessions = false;
    renderTab();
    expect(screen.queryByRole('button', { name: 'sites.exportCsv' })).toBeNull();
  });
});
