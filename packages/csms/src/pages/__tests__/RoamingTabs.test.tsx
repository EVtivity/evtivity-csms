// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, refetchMock, query } = vi.hoisted(() => ({
  getMock: vi.fn(),
  refetchMock: vi.fn(),
  query: { value: { isLoading: false, isError: false } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => true,
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/hooks/use-paginated-query', () => ({
  usePaginatedQuery: () => ({
    data: [],
    isLoading: query.value.isLoading,
    isError: query.value.isError,
    refetch: refetchMock,
    page: 1,
    totalPages: 1,
    setPage: vi.fn(),
    search: '',
    setSearch: vi.fn(),
  }),
}));
vi.mock('../RoamingLayout', () => ({
  useRoamingTabAction: vi.fn(),
}));

import { RoamingPartners } from '../RoamingPartners';
import { RoamingLocations } from '../RoamingLocations';
import { RoamingSessions } from '../RoamingSessions';
import { RoamingCdrs } from '../RoamingCdrs';
import { RoamingTariffs } from '../RoamingTariffs';

function renderTab(tab: React.ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{tab}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  query.value = { isLoading: false, isError: false };
});

const PAGINATED_TABS = [
  {
    name: 'Partners',
    tab: <RoamingPartners />,
    title: 'nav.roamingPartners',
    empty: 'roaming.partners.noPartners',
  },
  {
    name: 'Sessions',
    tab: <RoamingSessions />,
    title: 'nav.roamingSessions',
    empty: 'roaming.sessions.noSessions',
  },
  { name: 'CDRs', tab: <RoamingCdrs />, title: 'nav.roamingCdrs', empty: 'roaming.cdrs.noCdrs' },
  {
    name: 'Tariffs',
    tab: <RoamingTariffs />,
    title: 'nav.roamingTariffs',
    empty: 'roaming.tariffs.noMappings',
  },
];

describe('Roaming tabs', () => {
  for (const { name, tab, title, empty } of PAGINATED_TABS) {
    it(`${name}: shows the tab label on the first panel and the empty state`, () => {
      renderTab(tab);
      const panels = screen.getAllByTestId('tab-panel');
      expect(within(panels[0] as HTMLElement).getByText(title)).toBeTruthy();
      expect(screen.getByTestId('empty-state').textContent).toBe(empty);
    });

    it(`${name}: shows the loading state`, () => {
      query.value = { isLoading: true, isError: false };
      renderTab(tab);
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it(`${name}: shows the load error with Retry`, () => {
      query.value = { isLoading: false, isError: true };
      renderTab(tab);
      expect(screen.getByTestId('error-state')).toBeTruthy();
      fireEvent.click(screen.getByText('common.retry'));
      expect(refetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('Locations: shows the tab label, then the load error with Retry', async () => {
    getMock.mockRejectedValue(new Error('down'));
    renderTab(<RoamingLocations />);
    expect(within(screen.getByTestId('tab-panel')).getByText('nav.roamingLocations')).toBeTruthy();
    expect(await screen.findByTestId('error-state')).toBeTruthy();
    getMock.mockResolvedValue([]);
    fireEvent.click(screen.getByText('common.retry'));
    expect((await screen.findByTestId('empty-state')).textContent).toBe(
      'roaming.locations.noLocations',
    );
  });
});
