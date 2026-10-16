// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// By default the financial stats answer with account sessions waiting for
// their fleet invoice; every other query stays pending (loading). A test sets
// `answers` to make a path answer or fail.
const { answers, requested } = vi.hoisted(() => ({
  answers: new Map<string, () => Promise<unknown>>(),
  requested: [] as string[],
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (path: string) => {
        requested.push(path);
        const answer = answers.get(path.split('?')[0] ?? path);
        if (answer != null) return answer();
        return path === '/v1/dashboard/financial-stats'
          ? Promise.resolve({ billedOnAccountCents: 20550, billedOnAccountCount: 9 })
          : new Promise(() => {});
      },
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
vi.mock('@/components/SessionsTable', () => ({
  SessionsTable: (props: {
    isLoading?: boolean;
    sessions?: unknown[];
    emptyMessage?: string;
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  }) => (
    <div
      data-testid="sessions-table"
      data-loading={String(props.isLoading === true)}
      data-rows={String(props.sessions?.length ?? -1)}
      data-empty={props.emptyMessage}
      data-total-pages={String(props.totalPages)}
    >
      <button
        type="button"
        data-testid="sessions-table-next"
        onClick={() => {
          props.onPageChange(props.page + 1);
        }}
      />
    </div>
  ),
}));

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

function renderDashboard(
  role: string,
  permissions: string[] = ['dashboard:read', 'payments:read'],
): void {
  useAuth.setState({ role, permissions, hasAllSiteAccess: true });
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
  answers.clear();
  requested.length = 0;
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

  it('TC-UI-LY-02 every role gets the same dashboard in the same order', () => {
    renderDashboard('operator');
    const insights = screen.getAllByTestId('active-insights');
    expect(insights).toHaveLength(1);
    const widget = insights[0] as HTMLElement;
    const stat = screen.getAllByText('dashboard.totalStations')[0] as HTMLElement;
    const chart = screen.getAllByTestId('chart')[0] as HTMLElement;
    expect(before(stat, widget)).toBe(true);
    expect(before(widget, chart)).toBe(true);
    // The role name no longer picks a smaller dashboard: the money row shows by permission.
    expect(screen.getAllByText('dashboard.totalRevenue').length).toBeGreaterThan(0);
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

describe('Dashboard states and permissions', () => {
  it('shows the loading mark on a card while its query loads, never a zero', () => {
    renderDashboard('admin');
    const card = screen.getAllByText('dashboard.totalStations')[0]?.closest('div.rounded-lg');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByRole('status')).toBeTruthy();
    expect(within(card as HTMLElement).queryByText('0')).toBeNull();
  });

  it('shows the load error with a Retry button that loads again', async () => {
    let calls = 0;
    answers.set('/v1/dashboard/stats', () => {
      calls += 1;
      return Promise.reject(new Error('down'));
    });
    renderDashboard('admin');
    const errors = await screen.findAllByText('common.loadError');
    expect(errors.length).toBeGreaterThan(0);
    const card = screen.getAllByText('dashboard.totalStations')[0]?.closest('div.rounded-lg');
    const retry = within(card as HTMLElement).getByRole('button', { name: 'common.retry' });
    const before = calls;
    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls).toBeGreaterThan(before);
    });
  });

  it('shows the stations count with the pending and blocked note', async () => {
    answers.set('/v1/dashboard/stats', () =>
      Promise.resolve({
        totalStations: 4,
        onlineStations: 2,
        onlinePercent: 50,
        activeSessions: 1,
        totalSessions: 10,
        totalEnergyWh: 1000,
        faultedStations: 0,
        statusCounts: {},
        onboardingStatusCounts: { accepted: 4, pending: 2, blocked: 1 },
      }),
    );
    renderDashboard('admin');
    expect(await screen.findByText('dashboard.stationsNotAccepted')).toBeTruthy();
  });

  it('asks for the uptime of the last 30 days', () => {
    renderDashboard('admin');
    expect(requested).toContain('/v1/dashboard/uptime?days=30');
  });

  it('hides the money row and asks for no money without payments:read', () => {
    renderDashboard('viewer', ['dashboard:read', 'stations:read']);
    expect(screen.queryByText('dashboard.totalRevenue')).toBeNull();
    expect(screen.queryByText('dashboard.profit')).toBeNull();
    expect(screen.getAllByText('dashboard.totalStations').length).toBeGreaterThan(0);
    for (const path of [
      '/v1/dashboard/financial-stats',
      '/v1/dashboard/revenue-history',
      '/v1/dashboard/payment-breakdown',
    ]) {
      expect(requested.some((r) => r.startsWith(path))).toBe(false);
    }
  });

  it('shows the Active Sessions card with sessions:read, loading then its rows', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    answers.set(
      '/v1/sessions',
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    renderDashboard('admin', ['dashboard:read', 'sessions:read']);
    expect(screen.getByText('charts.activeSessions')).toBeTruthy();
    const table = screen.getByTestId('sessions-table');
    expect(table.getAttribute('data-loading')).toBe('true');
    expect(table.getAttribute('data-empty')).toBe('charts.noActiveSessions');
    expect(requested).toContain('/v1/sessions?page=1&limit=20&status=active');
    resolve({ data: [{ id: 'ses_1' }], total: 1 });
    await waitFor(() => {
      expect(screen.getByTestId('sessions-table').getAttribute('data-rows')).toBe('1');
    });
  });

  it('pages the Active Sessions card 20 at a time', async () => {
    answers.set('/v1/sessions', () =>
      Promise.resolve({
        data: Array.from({ length: 20 }, (_, i) => ({ id: `ses_${String(i)}` })),
        total: 45,
      }),
    );
    renderDashboard('admin', ['dashboard:read', 'sessions:read']);
    // The page controls the card renders itself (SessionsTable has none).
    const next = await screen.findByRole('button', { name: /common\.next/ });
    expect(screen.getByText('common.pageOf')).toBeTruthy();
    fireEvent.click(next);
    await waitFor(() => {
      expect(requested).toContain('/v1/sessions?page=2&limit=20&status=active');
    });
  });

  it('shows the load error with Retry on the Active Sessions card', async () => {
    let calls = 0;
    answers.set('/v1/sessions', () => {
      calls += 1;
      return Promise.reject(new Error('down'));
    });
    renderDashboard('admin', ['dashboard:read', 'sessions:read']);
    const title = screen.getByText('charts.activeSessions');
    const card = title.closest('div.rounded-lg') as HTMLElement;
    const retry = await within(card).findByRole('button', { name: 'common.retry' });
    const before = calls;
    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls).toBeGreaterThan(before);
    });
  });

  it('hides the Active Sessions card without sessions:read', () => {
    renderDashboard('viewer', ['dashboard:read']);
    expect(screen.queryByText('charts.activeSessions')).toBeNull();
    expect(requested.some((r) => r.startsWith('/v1/sessions'))).toBe(false);
  });
});
