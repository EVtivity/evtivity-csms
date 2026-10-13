// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

// The theme store reads the color scheme on import; jsdom has no matchMedia.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
// The financial stats answer with account sessions waiting for their fleet
// invoice; every other query stays pending, so the layout renders its defaults.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (path: string) =>
        path === '/v1/dashboard/financial-stats'
          ? Promise.resolve({ billedOnAccountCents: 20550, billedOnAccountCount: 9 })
          : new Promise(() => {}),
    },
  };
});
vi.mock('@/hooks/use-update-check', () => ({ useUpdateCheck: () => undefined }));
vi.mock('@/components/ai/insights/ActiveInsightsWidget', () => ({
  ActiveInsightsWidget: () => <div data-testid="active-insights" />,
}));
vi.mock('@/components/charts/StationStatusChart', () => ({
  StationStatusChart: () => <div data-testid="chart" />,
}));
vi.mock('@/components/charts/EnergyChart', () => ({
  EnergyChart: () => <div data-testid="chart" />,
}));
vi.mock('@/components/charts/SessionsChart', () => ({ SessionsChart: () => null }));
vi.mock('@/components/charts/UtilizationChart', () => ({ UtilizationChart: () => null }));
vi.mock('@/components/charts/PeakUsageChart', () => ({ PeakUsageChart: () => null }));
vi.mock('@/components/charts/StationMapChart', () => ({ StationMapChart: () => null }));
vi.mock('@/components/charts/RevenueChart', () => ({ RevenueChart: () => null }));
vi.mock('@/components/charts/PaymentBreakdownChart', () => ({
  PaymentBreakdownChart: () => null,
}));
vi.mock('@/components/charts/Sparkline', () => ({ Sparkline: () => null }));
vi.mock('@/components/SessionsTable', () => ({ SessionsTable: () => null }));

// The tabs and stat cards measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { Dashboard, statGridClass } from '../Dashboard';
import { useAuth } from '@/lib/auth';

function renderDashboard(role: string): void {
  useAuth.setState({ role, permissions: ['*'], hasAllSiteAccess: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** True when `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  cleanup();
});

describe('Dashboard layout (plan v0.1.45, section 6)', () => {
  it('TC-UI-LY-01 the admin dashboard shows Active insights after the stat cards, before the charts', () => {
    renderDashboard('admin');
    const insights = screen.getAllByTestId('active-insights');
    expect(insights).toHaveLength(1);
    const widget = insights[0] as HTMLElement;
    const stat = screen.getAllByText('dashboard.totalRevenue')[0] as HTMLElement;
    const chart = screen.getAllByTestId('chart')[0] as HTMLElement;
    expect(before(stat, widget)).toBe(true);
    expect(before(widget, chart)).toBe(true);
    expect(before(screen.getByText('dashboard.title'), widget)).toBe(true);
  });

  it('TC-UI-LY-02 the operator dashboard uses the same order', () => {
    renderDashboard('operator');
    const insights = screen.getAllByTestId('active-insights');
    expect(insights).toHaveLength(1);
    const widget = insights[0] as HTMLElement;
    const stat = screen.getAllByText('dashboard.stations')[0] as HTMLElement;
    const chart = screen.getAllByTestId('chart')[0] as HTMLElement;
    expect(before(stat, widget)).toBe(true);
    expect(before(widget, chart)).toBe(true);
  });

  it('renders the account cards through the shared stat card, in a row that fits them', async () => {
    renderDashboard('admin');
    const billed = await screen.findByText('dashboard.billedOnAccount');
    const unpaid = screen.getByText('dashboard.billedOnAccountSessions');
    const revenue = screen.getByText('dashboard.totalRevenue');
    const stations = screen.getAllByText('dashboard.totalStations')[0] as HTMLElement;
    // The same title, header and card classes as Total Revenue and Total Stations.
    for (const reference of [revenue, stations]) {
      for (const title of [billed, unpaid]) {
        expect(title.className).toBe(reference.className);
        expect(title.parentElement?.className).toBe(reference.parentElement?.className);
        expect(title.parentElement?.parentElement?.className).toBe(
          reference.parentElement?.parentElement?.className,
        );
      }
    }
    // The row fits its two cards: stacked on phones, two equal columns from md,
    // with the gap of every stat row. The four-card rows keep their columns.
    const grid = (el: HTMLElement): HTMLElement =>
      el.parentElement?.parentElement?.parentElement as HTMLElement;
    expect(grid(billed)).toBe(grid(unpaid));
    expect(grid(billed).className).toBe('grid gap-4 grid-cols-1 md:grid-cols-2');
    expect(grid(revenue).className).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statGridClass(4)).toBe(grid(revenue).className);
    // The sliding row keeps the stat gap between its pages, so the account page
    // never sits flush against the cost page on a phone.
    const row = grid(revenue).parentElement?.parentElement as HTMLElement;
    expect(row.className).toContain('snap-x');
    expect(row.className).toContain('gap-4');
    expect(grid(billed).parentElement?.parentElement).toBe(row);
    expect(statGridClass(8)).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statGridClass(3)).toBe('grid gap-4 grid-cols-1 md:grid-cols-3');
    expect(statGridClass(1)).toBe('grid gap-4 grid-cols-1');
    for (const title of [billed, unpaid]) {
      const card = title.parentElement?.parentElement as HTMLElement;
      expect(card.className).not.toMatch(/(^|\s)-?m[xytrbl]?-/);
    }
  });
});
