// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AiInsightView } from '../insights/insight-api';

const { apiMock, perms, features } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn() },
  perms: new Set<string>(),
  features: { aiInsightsEnabled: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  formatRelativeTime: (v: string) => `ago:${v}`,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('../use-ai-status', () => ({
  useAiStatus: () => ({ chatbot: false, support: false, isLoading: false }),
}));

import { ActiveInsightsWidget } from '../insights/ActiveInsightsWidget';
import { InsightCard } from '../insights/InsightCard';
import { insightHeadline, insightRows } from '../insights/insight-display';
import { AiInsights } from '@/pages/AiInsights';
import { AiInsightDetail } from '@/pages/AiInsightDetail';

function insight(overrides: Partial<AiInsightView> = {}): AiInsightView {
  return {
    id: 'ins1',
    kind: 'station_offline',
    status: 'active',
    skipReason: null,
    siteId: 'site1',
    stationId: 'st1',
    sessionId: null,
    authorizeAttemptId: null,
    parentInsightId: null,
    category: 'connectivity',
    confidence: 'high',
    fixes: [{ code: 'check_network_connection', note: 'Cellular modem lost signal' }],
    scope: { site: { stationsOffline: 3 } },
    generatedBy: 'model',
    language: 'en',
    summary: 'The modem lost its signal after the storm.',
    textStatus: 'ready',
    originalSummary: null,
    stale: false,
    basisAt: '2026-10-10T10:00:00Z',
    createdAt: '2026-10-10T10:00:00Z',
    resolvedAt: null,
    dismissedAt: null,
    stationName: 'CS-1616',
    siteName: 'Convention Center',
    ...overrides,
  };
}

/** Answers the feature flags, the audit history and the insight requests. */
function serve(insights: AiInsightView[] | Error, total?: number): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/portal/features') return Promise.resolve(features);
    if (url.startsWith('/v1/audit')) return Promise.resolve({ data: [], total: 0 });
    if (insights instanceof Error) return Promise.reject(insights);
    if (url.startsWith('/v1/ai/insights/')) return Promise.resolve(insights[0]);
    return Promise.resolve({ data: insights, total: total ?? insights.length });
  });
}

function wrap(ui: React.ReactNode, path = '/'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const t = (key: string, o?: Record<string, unknown>): string =>
  o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`;

beforeEach(() => {
  perms.clear();
  perms.add('aiInsights:read');
  features.aiInsightsEnabled = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Active insights card', () => {
  it('builds each row from structured fields: what, where, how big, confidence and the first fix, no model text', async () => {
    serve([insight()]);
    wrap(<ActiveInsightsWidget />);
    const row = await screen.findByTestId('ai-insight-row');
    expect(within(row).getByTestId('ai-insight-headline').textContent).toBe(
      'aiInsights.headline.station_offline(CS-1616,Convention Center)',
    );
    expect(within(row).getByText('aiInsights.category.connectivity')).toBeTruthy();
    expect(
      within(row).getByText('aiInsights.widget.atDetection(aiInsights.scope.stationsOffline(3))'),
    ).toBeTruthy();
    expect(within(row).getByText('Convention Center')).toBeTruthy();
    expect(within(row).getByText('ago:2026-10-10T10:00:00Z')).toBeTruthy();
    expect(within(row).getByText('aiInsights.confidenceBadge.high')).toBeTruthy();
    expect(within(row).getByTestId('ai-insight-fix').textContent).toBe(
      'aiInsights.fix.check_network_connection',
    );
    expect(row.closest('a')?.getAttribute('href')).toBe('/ai/insights/ins1');
    expect(screen.queryByText(/modem lost its signal/)).toBeNull();
    expect(screen.queryByText(/Cellular modem/)).toBeNull();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights?status=active&limit=50&language=en');
    expect(screen.getByTestId('ai-insights-view-all').getAttribute('href')).toBe(
      '/ai/insights?status=active',
    );
  });

  it('orders site incidents first, then severity, then newest, and shows at most five rows', async () => {
    serve([
      insight({ id: 'a', kind: 'authorization_refused', category: 'token', siteId: 's1' }),
      insight({ id: 'o', kind: 'station_offline', category: 'connectivity', siteId: 's2' }),
      insight({ id: 'f', kind: 'station_faulted', category: 'hardware', siteId: 's3' }),
      insight({
        id: 'i',
        kind: 'site_incident',
        category: 'power_supply',
        siteId: 's4',
        stationId: null,
        scope: { site: { stationsOffline: 3 } },
      }),
      insight({ id: 's', kind: 'session_failed', category: 'vehicle', siteId: 's5' }),
      insight({ id: 't', kind: 'tariff_anomaly', category: 'tariff', siteId: 's6' }),
    ]);
    wrap(<ActiveInsightsWidget />);
    await screen.findAllByTestId('ai-insight-row');
    const hrefs = screen
      .getAllByTestId('ai-insight-row')
      .map((r) => r.closest('a')?.getAttribute('href'));
    expect(hrefs).toEqual([
      '/ai/insights/i',
      '/ai/insights/f',
      '/ai/insights/o',
      '/ai/insights/s',
      '/ai/insights/a',
    ]);
    expect(screen.getAllByTestId('ai-insight-headline')[0]?.textContent).toBe(
      'aiInsights.headline.siteIncidentOffline(3,Convention Center)',
    );
  });

  it('collapses the same category at one site into one row with a count that opens the filtered list', async () => {
    serve(
      [
        insight({ id: 'n1', createdAt: '2026-10-10T12:00:00Z' }),
        insight({ id: 'n2', stationName: 'CS-2', createdAt: '2026-10-10T11:00:00Z' }),
        insight({ id: 'n3', stationName: 'CS-3', createdAt: '2026-10-10T10:00:00Z' }),
      ],
      3,
    );
    wrap(<ActiveInsightsWidget />);
    const rows = await screen.findAllByTestId('ai-insight-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByTestId('ai-insight-similar').textContent).toBe(
      'aiInsights.widget.similar(2)',
    );
    expect(rows[0]?.closest('a')?.getAttribute('href')).toBe(
      '/ai/insights?status=active&kind=station_offline&siteId=site1&category=connectivity',
    );
    expect(screen.getByTestId('ai-insights-total').textContent).toBe('3');
  });

  it('shows the empty state while insights are generated, and nothing while they are off', async () => {
    serve([]);
    wrap(<ActiveInsightsWidget />);
    expect(await screen.findByText('aiInsights.widget.empty')).toBeTruthy();
    cleanup();
    features.aiInsightsEnabled = false;
    serve([]);
    wrap(<ActiveInsightsWidget />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/portal/features');
      expect(screen.queryByTestId('ai-active-insights')).toBeNull();
    });
  });

  it('shows the load error with a retry like the other dashboard cards', async () => {
    serve(new Error('offline'));
    wrap(<ActiveInsightsWidget />);
    expect(await screen.findByText('common.loadError')).toBeTruthy();
    const calls = apiMock.get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => {
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(calls);
    });
  });

  it('renders nothing and asks for no insight without aiInsights:read', () => {
    perms.clear();
    serve([insight()]);
    wrap(<ActiveInsightsWidget />);
    expect(screen.queryByTestId('ai-active-insights')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringContaining('/v1/ai/insights'));
  });
});

describe('scope on the insight card', () => {
  it('is collapsed by default, asks nothing for now until opened, then shows the table', async () => {
    serve([
      insight({
        scope: { site: { stationsOffline: 3, stations: 10 } },
        scopeNow: { site: { stationsOffline: 1, stations: 10 } },
        scopeNowAt: '2026-10-10T10:05:00Z',
      }),
    ]);
    wrap(
      <InsightCard insight={insight({ scope: { site: { stationsOffline: 3, stations: 10 } } })} />,
    );
    const trigger = screen.getByRole('button', { name: /aiInsights\.scopeTable\.title/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // Closed: the main measure at detection only.
    expect(trigger.textContent).toContain(
      'aiInsights.scopeTable.summaryAtDetection(aiInsights.scope.stationsOffline(3))',
    );
    expect(screen.queryByTestId('ai-insight-scope')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringContaining('scopeNow=true'));
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights/ins1?language=en&scopeNow=true');
    const table = await screen.findByTestId('ai-insight-scope');
    await waitFor(() => {
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
      );
      expect(rows).toEqual([
        ['aiInsights.scopeTable.area.site(aiInsights.scopeTable.measure.stations)', '10', '10'],
        [
          'aiInsights.scopeTable.area.site(aiInsights.scopeTable.measure.stationsOffline)',
          '3',
          '1',
        ],
      ]);
    });
    const head = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(head).toEqual([
      'aiInsights.scopeTable.measureHeader',
      'aiInsights.scopeTable.atDetection',
      'aiInsights.scopeTable.now',
    ]);
    // Only a changed value is emphasized, with weight and nothing else.
    const nowCells = table.querySelectorAll('tbody tr td:last-child');
    expect(nowCells[0]?.className).not.toContain('font-medium');
    expect(nowCells[1]?.className).toContain('font-medium');
    // Open, the summary names both values.
    expect(trigger.textContent).toContain(
      'aiInsights.scopeTable.summaryChanged(aiInsights.scope.stationsOffline(3),1)',
    );
  });
});

describe('translation on the insight card', () => {
  it('shows the original with a translating note, then swaps to the translation when the update arrives', async () => {
    const pending = insight({
      summary: null,
      textStatus: 'pending',
      originalSummary: 'The network connection dropped.',
    });
    serve([pending]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InsightCard
            insight={insight({
              summary: null,
              textStatus: 'unavailable',
              originalSummary: 'The network connection dropped.',
            })}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The card asks the detail, which requests the translation on the server.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights/ins1?language=en');
    });
    const note = await screen.findByTestId('ai-insight-translating');
    expect(note.textContent).toBe('aiInsights.summaryTranslating');
    expect(note.querySelector('img[src="/evtivity-spinner.svg"]')).not.toBeNull();
    expect(screen.getByTestId('ai-insight-summary').textContent).toBe(
      'The network connection dropped.',
    );
    // The translation is stored; the SSE event invalidates ['ai', 'insights'].
    serve([
      insight({
        summary: '网络连接中断。',
        textStatus: 'ready',
        originalSummary: 'The network connection dropped.',
      }),
    ]);
    await client.invalidateQueries({ queryKey: ['ai', 'insights'] });
    await waitFor(() => {
      expect(screen.getByTestId('ai-insight-summary').textContent).toBe('网络连接中断。');
    });
    expect(screen.queryByTestId('ai-insight-translating')).toBeNull();
    expect(screen.getByRole('button', { name: 'aiInsights.showOriginal' })).toBeTruthy();
  });

  it('says the original is shown when no translation can be made', async () => {
    serve([
      insight({
        summary: null,
        textStatus: 'unavailable',
        originalSummary: 'The network connection dropped.',
      }),
    ]);
    wrap(
      <InsightCard
        insight={insight({
          summary: null,
          textStatus: 'unavailable',
          originalSummary: 'The network connection dropped.',
        })}
      />,
    );
    expect((await screen.findByTestId('ai-insight-translating')).textContent).toBe(
      'aiInsights.summaryUnavailable',
    );
    expect(screen.getByTestId('ai-insight-summary').textContent).toBe(
      'The network connection dropped.',
    );
  });
});

describe('insight display helpers', () => {
  it('names a faulted site incident by its faulted count and falls back without names', () => {
    expect(
      insightHeadline(
        t as never,
        insight({ kind: 'site_incident', scope: { site: { stationsFaulted: 4 } } }),
      ),
    ).toBe('aiInsights.headline.siteIncidentFaulted(4,Convention Center)');
    expect(
      insightHeadline(t as never, insight({ stationName: null, siteName: null, stationId: 'x' })),
    ).toBe(
      'aiInsights.headline.station_offline(aiInsights.headline.noStation,aiInsights.headline.noSite)',
    );
  });

  it('never collapses site incidents, summaries or an unknown root cause', () => {
    const rows = insightRows(
      [
        insight({ id: 'i1', kind: 'site_incident' }),
        insight({ id: 'i2', kind: 'site_incident' }),
        insight({ id: 'u1', category: 'unknown' }),
        insight({ id: 'u2', category: 'unknown' }),
        insight({ id: 'm1', kind: 'site_summary', category: null }),
      ],
      10,
    );
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('insights list and detail pages', () => {
  it('reads the filters from the URL, lists the insights in the standard table and opens one', async () => {
    serve([insight()]);
    wrap(
      <Routes>
        <Route path="/ai/insights" element={<AiInsights />} />
        <Route path="/ai/insights/:id" element={<p>insight page</p>} />
      </Routes>,
      '/ai/insights?status=active&siteId=site1&category=connectivity',
    );
    const row = await screen.findByTestId('ai-insight-list-row');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?status=active&category=connectivity&siteId=site1&limit=20&language=en&page=1',
    );
    expect(within(row).getByText('CS-1616')).toBeTruthy();
    expect(within(row).getByText('aiInsights.status.active')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('aiInsights.list.kind'), {
      target: { value: 'station_faulted' },
    });
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenLastCalledWith(
        '/v1/ai/insights?status=active&kind=station_faulted&category=connectivity&siteId=site1&limit=20&language=en&page=1',
      );
    });
    fireEvent.click((await screen.findAllByTestId('ai-insight-list-row'))[0] as HTMLElement);
    expect(await screen.findByText('insight page')).toBeTruthy();
  });

  it('the detail page has the standard header, the insight card, the records and the history', async () => {
    perms.add('audit:read');
    serve([insight({ sessionId: 'se1' })]);
    wrap(
      <Routes>
        <Route path="/ai/insights/:id" element={<AiInsightDetail />} />
      </Routes>,
      '/ai/insights/ins1',
    );
    expect((await screen.findByTestId('ai-insight-title')).textContent).toBe(
      'aiInsights.headline.station_offline(CS-1616,Convention Center)',
    );
    expect(screen.getByTestId('ai-insight-status').textContent).toBe('aiInsights.status.active');
    expect(screen.getByTestId('ai-insight-card')).toBeTruthy();
    expect(screen.getByText('CS-1616').closest('a')?.getAttribute('href')).toBe('/stations/st1');
    expect(screen.getByText('se1').closest('a')?.getAttribute('href')).toBe('/sessions/se1');
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/audit/ai_insight/ins1?page=1&limit=20');
    });
  });
});
