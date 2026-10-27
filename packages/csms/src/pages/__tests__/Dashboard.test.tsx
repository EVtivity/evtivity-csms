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
// The saved dashboard layout answers the default unless a test sets one.
const { answers, requested, writes } = vi.hoisted(() => ({
  answers: new Map<string, () => Promise<unknown>>(),
  requested: [] as string[],
  writes: [] as Array<{ method: string; path: string; body?: unknown }>,
}));
const LAYOUT_PATH = '/v1/users/me/dashboard-layout';
const defaultLayoutReply = () =>
  import('@evtivity/lib/dashboard-layout').then((m) => ({
    layout: m.defaultDashboardLayout(),
    customized: false,
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
        if (path === LAYOUT_PATH) return defaultLayoutReply();
        return path === '/v1/dashboard/financial-stats'
          ? Promise.resolve({ billedOnAccountCents: 20550, billedOnAccountCount: 9 })
          : new Promise(() => {});
      },
      put: (path: string, body: unknown) => {
        writes.push({ method: 'PUT', path, body });
        return Promise.resolve({ layout: body, customized: true });
      },
      delete: (path: string) => {
        writes.push({ method: 'DELETE', path });
        return defaultLayoutReply();
      },
    },
  };
});
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: { aiInsightsEnabled: true } }),
}));
vi.mock('@/components/charts/LocationsByCityChart', () => ({
  LocationsByCityChart: () => <div data-testid="chart-locations-by-city" />,
}));
vi.mock('@/components/charts/EvsesByConnectorTypeChart', () => ({
  EvsesByConnectorTypeChart: () => <div data-testid="chart-evses-by-connector-type" />,
}));
vi.mock('@/components/charts/PlugAndChargeChart', () => ({
  PlugAndChargeChart: () => <div data-testid="chart-plug-and-charge" />,
}));
vi.mock('@/components/charts/FreeVendChart', () => ({
  FreeVendChart: () => <div data-testid="chart-free-vend" />,
}));
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
import {
  defaultDashboardLayout,
  resolveDashboardLayout,
  type DashboardLayout,
} from '@evtivity/lib/dashboard-layout';

/** Renders the dashboard and waits for the saved layout (the Live charts wait for it). */
async function renderDashboard(
  role: string,
  permissions: string[] = ['dashboard:read', 'payments:read'],
): Promise<void> {
  useAuth.setState({ role, permissions, hasAllSiteAccess: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId('dashboard-charts');
}

/** True when `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  cleanup();
  answers.clear();
  requested.length = 0;
  writes.length = 0;
});

describe('Dashboard layout (plan v0.1.45, section 6)', () => {
  it('TC-UI-LY-01 the admin dashboard shows Active insights after the stat cards, before the charts', async () => {
    await renderDashboard('admin', ['dashboard:read', 'payments:read', 'aiInsights:read']);
    const insights = screen.getAllByTestId('active-insights');
    expect(insights).toHaveLength(1);
    const widget = insights[0] as HTMLElement;
    const stat = screen.getAllByText('dashboard.totalRevenue')[0] as HTMLElement;
    const chart = screen.getAllByTestId('chart')[0] as HTMLElement;
    expect(before(stat, widget)).toBe(true);
    expect(before(widget, chart)).toBe(true);
    expect(before(screen.getByText('dashboard.title'), widget)).toBe(true);
  });

  it('TC-UI-LY-02 every role gets the same dashboard in the same order', async () => {
    await renderDashboard('operator', ['dashboard:read', 'payments:read', 'aiInsights:read']);
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
    await renderDashboard('admin');
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
  it('shows the loading mark on a card while its query loads, never a zero', async () => {
    await renderDashboard('admin');
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
    await renderDashboard('admin');
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
    await renderDashboard('admin');
    expect(await screen.findByText('dashboard.stationsNotAccepted')).toBeTruthy();
  });

  it('asks for the uptime of the last 30 days', async () => {
    await renderDashboard('admin');
    expect(requested).toContain('/v1/dashboard/uptime?days=30');
  });

  it('hides the money row and asks for no money without payments:read', async () => {
    await renderDashboard('viewer', ['dashboard:read', 'stations:read']);
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
    await renderDashboard('admin', ['dashboard:read', 'sessions:read']);
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
    await renderDashboard('admin', ['dashboard:read', 'sessions:read']);
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
    await renderDashboard('admin', ['dashboard:read', 'sessions:read']);
    const title = screen.getByText('charts.activeSessions');
    const card = title.closest('div.rounded-lg') as HTMLElement;
    const retry = await within(card).findByRole('button', { name: 'common.retry' });
    const before = calls;
    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls).toBeGreaterThan(before);
    });
  });

  it('hides the Active Sessions card without sessions:read', async () => {
    await renderDashboard('viewer', ['dashboard:read']);
    expect(screen.queryByText('charts.activeSessions')).toBeNull();
    expect(requested.some((r) => r.startsWith('/v1/sessions'))).toBe(false);
  });
});

describe('Dashboard layout customizing', () => {
  /** Answers the saved layout: the given charts first, the rest in the default order. */
  function savedLayout(stored: Record<string, unknown>): void {
    answers.set(LAYOUT_PATH, () =>
      Promise.resolve({ layout: resolveDashboardLayout(stored), customized: true }),
    );
  }

  const NEW_CHART_PATHS = [
    '/v1/dashboard/locations-by-city',
    '/v1/dashboard/evses-by-connector-type',
    '/v1/dashboard/plug-and-charge',
    '/v1/dashboard/free-vend',
  ];

  it('hides Active insights without aiInsights:read', async () => {
    await renderDashboard('admin');
    expect(screen.queryByTestId('active-insights')).toBeNull();
  });

  it('hides the four new charts by default and never fetches them', async () => {
    await renderDashboard('admin');
    for (const id of [
      'locations-by-city',
      'evses-by-connector-type',
      'plug-and-charge',
      'free-vend',
    ]) {
      expect(screen.queryByTestId(`chart-${id}`)).toBeNull();
    }
    for (const path of NEW_CHART_PATHS) {
      expect(requested.some((r) => r.startsWith(path))).toBe(false);
    }
  });

  it('renders the saved chart order, hides hidden charts and fetches a shown new chart', async () => {
    savedLayout({
      version: 1,
      charts: [
        { id: 'chart.freeVend', hidden: false },
        { id: 'chart.stationStatus', hidden: true },
      ],
    });
    await renderDashboard('admin');
    const freeVend = screen.getByTestId('chart-free-vend');
    // Energy is the only mocked chart left with the "chart" test id.
    const charts = screen.getAllByTestId('chart');
    expect(charts).toHaveLength(1);
    expect(before(freeVend, charts[0] as HTMLElement)).toBe(true);
    expect(requested.some((r) => r.startsWith('/v1/dashboard/free-vend'))).toBe(true);
    expect(requested.some((r) => r.startsWith('/v1/dashboard/plug-and-charge'))).toBe(false);
  });

  it('keeps the stat cards fixed whatever a layout stored before says', async () => {
    savedLayout({
      version: 1,
      cards: [
        { id: 'card.totalPorts', hidden: false },
        { id: 'card.uptime', hidden: true },
      ],
      charts: [],
    });
    await renderDashboard('admin');
    const ports = screen.getByText('dashboard.totalPorts');
    const stations = screen.getAllByText('dashboard.totalStations')[0] as HTMLElement;
    expect(before(stations, ports)).toBe(true);
    expect(screen.getByText('dashboard.uptime')).toBeTruthy();
  });

  it('gives the stat cards no drag handle or hide button and never lists them as hidden', async () => {
    await renderDashboard('admin');
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.customize' }));
    expect(document.querySelector('[data-widget^="card."]')).toBeNull();
    const uptime = screen.getByText('dashboard.uptime').closest('div.rounded-lg') as HTMLElement;
    expect(within(uptime).queryByRole('button', { name: 'dashboard.hideWidget' })).toBeNull();
    const show = screen.getAllByRole('button', { name: 'dashboard.showWidget' });
    expect(show.map((b) => b.textContent)).not.toContain('dashboard.uptime');
  });

  it('keeps a money chart hidden without payments:read whatever the layout', async () => {
    savedLayout({ version: 1, charts: [{ id: 'chart.revenue', hidden: false }] });
    await renderDashboard('viewer', ['dashboard:read']);
    expect(screen.queryByText('dashboard.totalRevenue')).toBeNull();
    expect(document.querySelector('[data-widget="chart.revenue"]')).toBeNull();
  });

  it('hides a chart, offers it back, and resets the layout', async () => {
    savedLayout({ version: 1, charts: [{ id: 'chart.freeVend', hidden: false }] });
    await renderDashboard('admin');
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.customize' }));
    const freeVend = screen
      .getByTestId('chart-free-vend')
      .closest('[data-widget="chart.freeVend"]') as HTMLElement;
    fireEvent.click(within(freeVend).getByRole('button', { name: 'dashboard.hideWidget' }));
    const charts = screen.getByTestId('dashboard-charts');
    await waitFor(() => {
      expect(within(charts).queryByTestId('chart-free-vend')).toBeNull();
    });
    const hidePut = writes.find((w) => w.method === 'PUT');
    expect(hidePut?.path).toBe(LAYOUT_PATH);
    const body = hidePut?.body as DashboardLayout & { cards?: unknown };
    expect(body.cards).toBeUndefined();
    expect(body.charts.find((c) => c.id === 'chart.freeVend')?.hidden).toBe(true);
    // The hidden list offers it back, with the other new charts hidden by default.
    const show = screen.getAllByRole('button', { name: 'dashboard.showWidget' });
    expect(show.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['dashboard.freeVend', 'dashboard.plugAndCharge']),
    );
    fireEvent.click(show.find((b) => b.textContent === 'dashboard.freeVend') as HTMLElement);
    expect(await within(charts).findByTestId('chart-free-vend')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'dashboard.resetLayout' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'dashboard.resetLayout' }));
    await waitFor(() => {
      expect(writes.some((w) => w.method === 'DELETE' && w.path === LAYOUT_PATH)).toBe(true);
    });
    expect(defaultDashboardLayout().charts[0]?.id).toBe('chart.aiInsights');
  });

  it('offers Customize in the Live view only', async () => {
    await renderDashboard('admin');
    expect(screen.getByRole('button', { name: 'dashboard.customize' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.trend' }));
    expect(screen.queryByRole('button', { name: 'dashboard.customize' })).toBeNull();
  });
});
