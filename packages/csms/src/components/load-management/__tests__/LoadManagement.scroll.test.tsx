// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

import { LoadManagement } from '../LoadManagement';

const station = {
  id: 'cs1',
  stationId: 'STATION-001',
  currentDrawKw: 7,
  allocatedLimitKw: 11,
  maxPowerKw: 22,
  loadPriority: 1,
  loadMinPowerKw: null,
  rateUnit: 'A',
  isOnline: true,
  hasActiveSession: false,
};

const panel = {
  id: 'p1',
  name: 'Main Switchboard',
  breakerRatingAmps: 400,
  voltageV: 400,
  phases: 1,
  maxContinuousKw: 100,
  safetyMarginKw: 5,
  oversubscriptionRatio: 1,
  currentDrawKw: 20,
  availableKw: 75,
  utilization: 0.2,
  totalConnectedKw: 22,
  phaseLoad: null,
  perPhaseCapacityKw: null,
  circuits: [
    {
      id: 'c1',
      name: 'Circuit A',
      breakerRatingAmps: 63,
      maxContinuousKw: 30,
      currentDrawKw: 7,
      availableKw: 23,
      stations: [station],
      unmanagedLoads: [],
    },
  ],
  childPanels: [],
  unmanagedLoads: [],
};

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LoadManagement siteId="site1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoadManagement on narrow screens', () => {
  it('keeps the panel tree and its one-line station rows inside the tree scroll container', async () => {
    apiMock.get.mockResolvedValue({
      config: { strategy: 'equal_share', isEnabled: true },
      hierarchy: [panel],
      stations: [station],
    });
    renderTab();

    const panelName = await screen.findByText('Main Switchboard');
    const treeScroll = screen.getByTestId('panel-tree-scroll');
    expect(treeScroll.className).toContain('overflow-x-auto');
    expect(treeScroll.contains(panelName)).toBe(true);
    // The tree keeps a minimum width, so it scrolls instead of squeezing at 375 px.
    expect(treeScroll.firstElementChild?.className).toMatch(/min-w-\[/);

    // No separate allocations table: the station rows live under their circuit.
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.expand' }));
    const table = screen.getByRole('table');
    expect(treeScroll.contains(table)).toBe(true);
    for (const cell of screen.getAllByRole('cell')) {
      expect(cell.className).toContain('whitespace-nowrap');
    }
  });

  it('renders no tree scroll container without panels', async () => {
    apiMock.get.mockResolvedValue({
      config: null,
      hierarchy: [],
      stations: [],
    });
    renderTab();

    await screen.findByText('loadManagement.noPanels');
    expect(screen.queryByTestId('panel-tree-scroll')).toBeNull();
  });
});
