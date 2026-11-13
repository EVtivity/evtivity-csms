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
const featureFlagsState = vi.hoisted(() => ({ isLoading: false }));
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: { aiInsightsEnabled: true },
    isLoading: featureFlagsState.isLoading,
    isLoaded: !featureFlagsState.isLoading,
  }),
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
vi.mock('@/components/charts/SecurityEventsCard', () => ({
  SecurityEventsCard: () => <div data-testid="security-events-card" />,
}));
vi.mock('@/components/charts/EnergyChart', () => ({
  EnergyChart: () => <div data-testid="chart" />,
}));
vi.mock('@/components/charts/SessionsChart', () => ({ SessionsChart: () => null }));
vi.mock('@/components/charts/UtilizationChart', () => ({ UtilizationChart: () => null }));
vi.mock('@/components/charts/PeakUsageChart', () => ({ PeakUsageChart: () => null }));
vi.mock('@/components/charts/StationMapChart', () => ({
  StationMapChart: () => <div data-testid="station-map" />,
}));
// The 3D widget has its own tests (SiteLayoutWidget.test.tsx): a stub with its props.
vi.mock('@/components/dashboard/SiteLayoutWidget', () => ({
  SiteLayoutWidget: (props: {
    siteId: string | null;
    siteUnavailable: boolean;
    onSiteChange: (siteId: string) => void;
  }) => (
    <button
      type="button"
      data-testid="site-layout-widget"
      data-site={String(props.siteId)}
      data-unavailable={String(props.siteUnavailable)}
      onClick={() => {
        props.onSiteChange('sit_picked');
      }}
    />
  ),
}));
vi.mock('@/components/charts/RevenueChart', () => ({ RevenueChart: () => null }));
vi.mock('@/components/charts/PaymentBreakdownChart', () => ({
  PaymentBreakdownChart: () => null,
}));
vi.mock('@/components/charts/Sparkline', () => ({ Sparkline: () => null }));
vi.mock('@/components/SessionsTable', () => ({
  ALL_SESSIONS_SORT_KEYS: ['station'],
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

import { Dashboard, statCardCount, statGridClass, statGridColumns } from '../Dashboard';
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
  hasAllSiteAccess = true,
): Promise<void> {
  useAuth.setState({ role, permissions, hasAllSiteAccess });
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
  featureFlagsState.isLoading = false;
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
    expect(grid(billed).className).toBe('grid gap-4 grid-cols-2');
    expect(grid(revenue).className).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statGridClass(4)).toBe(grid(revenue).className);
    // The sliding row keeps the stat gap between its pages, so the account page
    // never sits flush against the cost page on a phone.
    const row = grid(revenue).parentElement?.parentElement as HTMLElement;
    expect(row.className).toContain('snap-x');
    expect(row.className).toContain('gap-4');
    expect(grid(billed).parentElement?.parentElement).toBe(row);
    expect(statGridClass(8)).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statGridClass(3)).toBe(
      'grid gap-4 grid-cols-2 md:grid-cols-3 [&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1',
    );
    expect(statGridClass(1)).toBe('grid gap-4 grid-cols-1');
    for (const title of [billed, unpaid]) {
      const card = title.parentElement?.parentElement as HTMLElement;
      expect(card.className).not.toMatch(/(^|\s)-?m[xytrbl]?-/);
    }
  });
});

describe('Dashboard states and permissions', () => {
  it('renders the charts only after the feature flags answered, so Active insights never shifts them', async () => {
    featureFlagsState.isLoading = true;
    useAuth.setState({
      role: 'operator',
      permissions: ['dashboard:read', 'aiInsights:read'],
      hasAllSiteAccess: true,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The saved layout answered: only the flags still hold the charts back.
    await waitFor(() => {
      expect(requested).toContain('/v1/users/me/dashboard-layout');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('dashboard-charts')).toBeNull();
    featureFlagsState.isLoading = false;
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const charts = await screen.findByTestId('dashboard-charts');
    const [insights] = screen.getAllByTestId('active-insights');
    const status = charts.querySelector('[data-widget="chart.stationStatus"]');
    expect(insights).toBeDefined();
    expect(status).not.toBeNull();
    if (insights == null || status == null) return;
    expect(before(insights, status)).toBe(true);
  });

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

  it('shows the Charging Units count from the stats', async () => {
    answers.set('/v1/dashboard/stats', () =>
      Promise.resolve({
        totalStations: 1,
        onlineStations: 1,
        onlinePercent: 100,
        activeSessions: 0,
        totalSessions: 0,
        totalEnergyWh: 0,
        faultedStations: 0,
        chargingUnits: 8,
        hasStationUnits: true,
        statusCounts: {},
        onboardingStatusCounts: { accepted: 1 },
      }),
    );
    await renderDashboard('admin');
    const card = (await screen.findByText('dashboard.chargingUnits')).closest('div.rounded-lg');
    await waitFor(
      () => {
        expect(within(card as HTMLElement).getByText('8')).toBeTruthy();
      },
      { timeout: 5000 },
    ); // the value animates in; a loaded run takes longer
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

  it('hides the Security Events card by default, also with securityEvents:read', async () => {
    await renderDashboard('operator', ['dashboard:read', 'securityEvents:read']);
    expect(screen.queryByTestId('security-events-card')).toBeNull();
  });

  it('shows the Security Events card right after the station status chart once the layout shows it', async () => {
    savedLayout({
      version: 1,
      charts: defaultDashboardLayout().charts.map((c) =>
        c.id === 'chart.securityEvents' ? { ...c, hidden: false } : c,
      ),
    });
    await renderDashboard('operator', ['dashboard:read', 'securityEvents:read']);
    const card = await screen.findByTestId('security-events-card');
    const status = screen.getAllByTestId('chart')[0] as HTMLElement;
    expect(before(status, card)).toBe(true);
    const energy = screen.getAllByTestId('chart')[1] as HTMLElement;
    expect(before(card, energy)).toBe(true);
  });

  it('hides the Security Events card without securityEvents:read, also when the layout shows it', async () => {
    savedLayout({
      version: 1,
      charts: defaultDashboardLayout().charts.map((c) =>
        c.id === 'chart.securityEvents' ? { ...c, hidden: false } : c,
      ),
    });
    await renderDashboard('viewer', ['dashboard:read']);
    expect(screen.queryByTestId('security-events-card')).toBeNull();
  });

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

  it('shows the 3D site layout above the map with sites:read, and never without it', async () => {
    await renderDashboard('admin', ['dashboard:read', 'sites:read']);
    const widget = screen.getByTestId('site-layout-widget');
    expect(before(widget, screen.getByTestId('station-map'))).toBe(true);
    expect(widget.getAttribute('data-site')).toBe('null');
    cleanup();

    await renderDashboard('viewer', ['dashboard:read']);
    expect(screen.queryByTestId('site-layout-widget')).toBeNull();
    expect(screen.getByTestId('station-map')).toBeTruthy();
  });

  it('enters a layout saved before it above the map, and saves the picked site', async () => {
    // Saved before the widget existed, with the map moved first.
    savedLayout({
      version: 1,
      charts: [
        { id: 'chart.stationMap', hidden: false },
        { id: 'chart.energy', hidden: false },
      ],
    });
    await renderDashboard('admin', ['dashboard:read', 'sites:read']);
    const widget = screen.getByTestId('site-layout-widget');
    expect(before(widget, screen.getByTestId('station-map'))).toBe(true);
    expect(
      before(screen.getByTestId('station-map'), screen.getAllByTestId('chart')[0] as HTMLElement),
    ).toBe(true);

    fireEvent.click(widget);
    await waitFor(() => {
      expect(writes.some((w) => w.method === 'PUT')).toBe(true);
    });
    const body = writes.find((w) => w.method === 'PUT')?.body as DashboardLayout;
    expect(body.charts.find((c) => c.id === 'chart.siteLayout3d')).toEqual({
      id: 'chart.siteLayout3d',
      hidden: false,
      siteId: 'sit_picked',
    });
    expect(await screen.findByTestId('site-layout-widget')).toHaveProperty(
      'dataset.site',
      'sit_picked',
    );
  });

  it('passes a site the user lost to the widget as unavailable', async () => {
    answers.set(LAYOUT_PATH, () =>
      Promise.resolve({
        layout: {
          version: 1,
          charts: [
            { id: 'chart.siteLayout3d', hidden: false, siteId: null, siteUnavailable: true },
          ],
        },
        customized: true,
      }),
    );
    await renderDashboard('admin', ['dashboard:read', 'sites:read']);
    const widget = screen.getByTestId('site-layout-widget');
    expect(widget.getAttribute('data-site')).toBe('null');
    expect(widget.getAttribute('data-unavailable')).toBe('true');
  });

  it('offers Customize in the Live view only', async () => {
    await renderDashboard('admin');
    expect(screen.getByRole('button', { name: 'dashboard.customize' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.trend' }));
    expect(screen.queryByRole('button', { name: 'dashboard.customize' })).toBeNull();
  });
});

describe('dashboard stat row column count', () => {
  it('counts each card inside a fragment, so a four-card row gets four columns', () => {
    // The Historical money cards sit in a fragment; counting it as one card gave
    // a row of four cards three columns, which wrapped onto the charts below.
    const row = (
      <>
        <p>Day Energy</p>
        <p>Day Sessions</p>
        <>
          <p>Day Revenue</p>
          <p>Day Transactions</p>
        </>
      </>
    );
    expect(statCardCount(row)).toBe(4);
    expect(statGridClass(statCardCount(row))).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statCardCount([<p key="a">A</p>, false, null, <p key="b">B</p>])).toBe(2);
  });
});

describe('live health row for a site-restricted user', () => {
  const rowOf = (title: string): HTMLElement =>
    screen.getByText(title).parentElement?.parentElement?.parentElement as HTMLElement;
  const withUnits = (): void => {
    answers.set('/v1/dashboard/stats', () =>
      Promise.resolve({
        totalStations: 1,
        onlineStations: 1,
        onlinePercent: 100,
        activeSessions: 0,
        totalSessions: 0,
        totalEnergyWh: 0,
        faultedStations: 0,
        chargingUnits: 8,
        hasStationUnits: true,
        statusCounts: {},
        onboardingStatusCounts: { accepted: 1 },
      }),
    );
  };

  it('keeps six cards across and no Charging Units card for an all-site user without units', async () => {
    await renderDashboard('admin', ['dashboard:read'], true);
    expect(screen.getByText('dashboard.pingLatency')).toBeTruthy();
    expect(screen.queryByText('dashboard.chargingUnits')).toBeNull();
    expect(rowOf('dashboard.totalStations').children).toHaveLength(6);
    expect(rowOf('dashboard.totalPorts').className).toBe(
      'grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6',
    );
  });

  it('lays the four cards left without the ping cards four across, with no gaps, without units', async () => {
    await renderDashboard('operator', ['dashboard:read'], false);
    expect(screen.queryByText('dashboard.pingLatency')).toBeNull();
    expect(screen.queryByText('dashboard.chargingUnits')).toBeNull();
    const row = rowOf('dashboard.totalPorts');
    expect(row.children).toHaveLength(4);
    expect(row.className).toBe(statGridClass(4));
  });

  it('puts the station, charging unit and port counts first, every row full, for an all-site user with units', async () => {
    withUnits();
    await renderDashboard('admin', ['dashboard:read'], true);
    await screen.findByText('dashboard.chargingUnits');
    expect(screen.getByText('dashboard.pingLatency')).toBeTruthy();
    const counts = rowOf('dashboard.chargingUnits');
    expect(counts).toBe(rowOf('dashboard.totalPorts'));
    expect(counts.children).toHaveLength(6);
    expect(counts.className).toBe('grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6');
    const order = Array.from(counts.children).map((c) => c.textContent);
    expect(order[0]).toContain('dashboard.totalStations');
    expect(order[1]).toContain('dashboard.chargingUnits');
    expect(order[2]).toContain('dashboard.totalPorts');
    expect(rowOf('dashboard.faults').children).toHaveLength(4);
    const ping = rowOf('dashboard.pingLatency');
    expect(ping.children).toHaveLength(3);
    expect(ping).toBe(rowOf('dashboard.ocppConnections'));
  });

  it('lays the eleven cards without the ping cards in rows of six, three and two, with units', async () => {
    withUnits();
    await renderDashboard('operator', ['dashboard:read'], false);
    await screen.findByText('dashboard.chargingUnits');
    expect(screen.queryByText('dashboard.pingLatency')).toBeNull();
    expect(rowOf('dashboard.chargingUnits').children).toHaveLength(6);
    const middle = rowOf('dashboard.faults');
    expect(middle.children).toHaveLength(3);
    expect(middle.className).toBe(statGridClass(3));
    const last = rowOf('dashboard.ocppConnections');
    expect(last.children).toHaveLength(2);
    expect(last).toBe(rowOf('dashboard.totalSessions'));
    expect(last.className).toBe(statGridClass(2));
  });
});

describe('stat rows fill every viewport', () => {
  // Every card count a dashboard row can hold: Live 6, 4 (no all-site access)
  // and the money grids 4 and 2; Historical 4, 2 and 1; Trend 8 and 6.
  it.each([1, 2, 3, 4, 6, 8])('puts %i cards in whole rows on md, lg and xl', (count) => {
    for (const cols of statGridColumns(count).slice(1)) {
      expect(count % cols).toBe(0);
    }
  });

  it.each([2, 3, 4, 6, 8])(
    'puts %i cards two across on phones, an odd last card full width',
    (count) => {
      expect(statGridColumns(count)[0]).toBe(2);
      const spans = statGridClass(count).includes('[&>*:last-child]:col-span-2');
      expect(spans).toBe(count % 2 === 1);
    },
  );

  it('keeps the layouts that already filled their rows from md up', () => {
    expect(statGridClass(1)).toBe('grid gap-4 grid-cols-1');
    expect(statGridClass(2)).toBe('grid gap-4 grid-cols-2');
    expect(statGridClass(3)).toBe(
      'grid gap-4 grid-cols-2 md:grid-cols-3 [&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1',
    );
    expect(statGridClass(4)).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
    expect(statGridClass(6)).toBe('grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6');
    expect(statGridClass(8)).toBe('grid gap-4 grid-cols-2 lg:grid-cols-4');
  });
});
