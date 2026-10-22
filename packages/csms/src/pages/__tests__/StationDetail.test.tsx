// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ai/use-ai-status', () => ({
  useAiStatus: () => ({ chatbot: true, support: false, isLoading: false }),
}));
vi.mock('@/hooks/use-entity-neighbors', () => ({
  useEntityNeighbors: () => ({ prevId: 'st0', nextId: 'st2' }),
}));
// The tab contents and record cards are covered by their own tests.
vi.mock('@/components/station/StationInfoTab', () => ({
  StationInfoTab: ({ simEnabled }: { simEnabled?: boolean }) => (
    <p data-testid="info-tab">{simEnabled === true ? 'sim-on' : 'sim-off'}</p>
  ),
}));
vi.mock('@/components/station/StationConnectivityTab', () => ({
  StationConnectivityTab: ({ stationSignalEnabled }: { stationSignalEnabled: boolean }) => (
    <p data-testid="connectivity-tab">{stationSignalEnabled ? 'signal-on' : 'signal-off'}</p>
  ),
}));
vi.mock('@/components/ai/insights/RecordInsight', () => ({ RecordInsight: () => null }));
vi.mock('@/components/ai/inbox/RecordProposals', () => ({ RecordProposals: () => null }));

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { ApiError } from '@/lib/api';
import { StationDetail } from '@/pages/StationDetail';

const STATION = {
  id: 'st1',
  stationId: 'CS-1',
  siteId: null,
  availability: 'available',
  status: 'available',
  statusReason: null,
  reportedStatus: 'available',
  disabledReason: null,
  firmwareState: null,
  isOnline: false,
  isSimulator: false,
  siteFreeVendEnabled: false,
  onboardingStatus: 'accepted',
  ocppProtocol: 'ocpp2.1',
};

/** The public feature flags; the SIM keys are left out while both SIM switches are off. */
let features: Record<string, unknown> = {};

function renderPage(station: Record<string, unknown> = STATION, initialTab = ''): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/stations/st1') return Promise.resolve(station);
    if (url === '/v1/portal/features') return Promise.resolve(features);
    if (url.startsWith('/v1/stations/st1/sim')) {
      return Promise.reject(new ApiError(500, { error: 'x', code: 'INTERNAL_ERROR' }));
    }
    return Promise.resolve({ data: [], total: 0 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/stations/st1${initialTab}`]}>
        <Routes>
          <Route path="/stations/:id" element={<StationDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The height classes of a button (`h-*` and `sm:h-*`). */
function heights(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter((c) => /^(sm:)?h-\d+$/.test(c));
}

beforeEach(() => {
  features = {};
  perms.clear();
  perms.add('stations:write');
  perms.add('aiAssistant:write');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('station header actions (ISSUES items 10 and 17)', () => {
  it('give Explain, Disable Station, Prev and Next one height and align their tops', async () => {
    renderPage();
    const row = await screen.findByTestId('station-header-actions');
    expect(row.className).toContain('items-start');
    const explain = within(row).getByTestId('ai-explain');
    const disable = within(row).getByRole('button', { name: 'stations.disableStation' });
    const prev = within(row).getByRole('button', { name: 'common.prev' });
    const next = within(row).getByRole('button', { name: 'common.next' });
    const expected = ['h-11', 'sm:h-10'];
    for (const button of [explain, disable, prev, next]) {
      expect(heights(button).sort()).toEqual(expected);
    }
  });

  it('gives Disable Station the destructive style and Explain the AI accent', async () => {
    renderPage();
    const row = await screen.findByTestId('station-header-actions');
    const disable = within(row).getByRole('button', { name: 'stations.disableStation' });
    expect(disable.className).toContain('bg-destructive');
    // The shared Disable button carries its power-off icon.
    expect(disable.querySelector('svg')).not.toBeNull();
    const explain = within(row).getByTestId('ai-explain');
    expect(explain.querySelector('svg')?.getAttribute('class')).toContain('text-link');
  });
});

describe('station tabs by OCPP version', () => {
  it.each([
    ['ocpp2.0.1', true],
    ['ocpp2.1', true],
    ['ocpp1.6', false],
  ])('a %s station shows the 2.x tabs: %s', async (ocppProtocol, shown) => {
    renderPage({ ...STATION, ocppProtocol });
    await screen.findByTestId('station-header-actions');
    for (const tab of ['pnc.certificates', 'stations.displayMessages', 'stations.events']) {
      expect(screen.queryByRole('tab', { name: tab }) != null).toBe(shown);
    }
  });
});

describe('station Connectivity tab (SIM features)', () => {
  it('sends no SIM request and shows no SIM field while both SIM switches are off', async () => {
    renderPage();
    await screen.findByTestId('station-header-actions');
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/portal/features');
    });
    expect(screen.queryByRole('tab', { name: 'stations.sim.tab' })).toBeNull();
    expect(screen.getByTestId('info-tab').textContent).toBe('sim-off');
    const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/sim'))).toBe(false);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('shows the tab and the ICCID field from the feature flags, whatever the SIM status answers', async () => {
    features = { simEnabled: true };
    renderPage();
    expect(await screen.findByRole('tab', { name: 'stations.sim.tab' })).toBeTruthy();
    expect(screen.getByTestId('info-tab').textContent).toBe('sim-on');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('tells the tab whether station signal reads are on', async () => {
    features = { simEnabled: true, simStationSignalEnabled: true };
    renderPage(STATION, '?tab=connectivity');
    expect((await screen.findByTestId('connectivity-tab')).textContent).toBe('signal-on');
  });
});
