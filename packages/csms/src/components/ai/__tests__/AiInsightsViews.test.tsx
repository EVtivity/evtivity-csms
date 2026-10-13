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
  features: { aiInsightsEnabled: true, reservationEnabled: true },
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
import { InsightQualityCard } from '../insights/InsightQualityCard';

function insight(overrides: Partial<AiInsightView> = {}): AiInsightView {
  return {
    id: 'ins1',
    kind: 'station_offline',
    status: 'open',
    skipReason: null,
    siteId: 'site1',
    stationId: 'st1',
    sessionId: null,
    authorizeAttemptId: null,
    reservationId: null,
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
    action: null,
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
    // Root cause, confidence and size share one dot-separated line; the meta line is where and when.
    expect(
      within(row).getByText(
        [
          'aiInsights.category.connectivity',
          'aiInsights.confidenceBadge.high',
          'aiInsights.widget.atDetection(aiInsights.scope.stationsOffline(3))',
        ].join(' · '),
      ),
    ).toBeTruthy();
    expect(within(row).getByText('Convention Center · ago:2026-10-10T10:00:00Z')).toBeTruthy();
    expect(within(row).getByTestId('ai-insight-fix').textContent).toBe(
      'aiInsights.fix.check_network_connection',
    );
    expect(row.closest('a')?.getAttribute('href')).toBe('/ai/insights/ins1');
    expect(screen.queryByText(/modem lost its signal/)).toBeNull();
    expect(screen.queryByText(/Cellular modem/)).toBeNull();
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?status=open%2Cpending&limit=50&language=en',
    );
    // The card shows open and pending insights, so View All opens every shown status.
    expect(screen.getByTestId('ai-insights-view-all').getAttribute('href')).toBe('/ai/insights');
  });

  it('marks a card whose action waits for a decision, and never collapses it', async () => {
    const pendingAction = {
      id: 'p1',
      job: 'stuck_sessions' as const,
      insightId: 'x',
      siteId: 's1',
      stationId: 'st1',
      sessionId: 'se1',
      operationId: 'ocppv21_RequestStopTransaction',
      method: 'POST',
      path: '/v1/ocpp/commands/v21/RequestStopTransaction',
      args: {},
      argsHash: 'h',
      summary: {},
      precondition: null,
      expiresAt: '2099-01-01T00:00:00Z',
      decidedBy: null,
      decidedAt: null,
      executedAt: null,
      result: null,
      createdAt: '2026-10-10T10:00:00Z',
    };
    serve([
      insight({
        id: 'x',
        kind: 'stuck_session',
        category: 'hardware',
        siteId: 's1',
        status: 'pending',
        action: pendingAction,
      }),
      insight({
        id: 'y',
        kind: 'stuck_session',
        category: 'hardware',
        siteId: 's1',
        status: 'pending',
        action: { ...pendingAction, id: 'p2', insightId: 'y' },
      }),
    ]);
    wrap(<ActiveInsightsWidget />);
    const rows = await screen.findAllByTestId('ai-insight-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('ai-insight-action-pending')[0]?.textContent).toBe(
      'aiInsights.status.pending',
    );
    // A stuck session's fix is its action: the tile names it instead of an empty fix line.
    expect(within(rows[0] as HTMLElement).getByTestId('ai-insight-fix').textContent).toMatch(
      /^aiInsights\.action\.kind\./,
    );
  });

  it('orders site incidents first, then severity, then newest, as scrollable cards', async () => {
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
      '/ai/insights/t',
    ]);
    // Item 13: one card per insight in the shared scroll row with its dot indicator.
    expect(screen.getByTestId('ai-insight-cards')).toBeTruthy();
    expect(screen.getByTestId('scroll-snap-dots')).toBeTruthy();
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
      '/ai/insights?status=open&kind=station_offline&siteId=site1&category=connectivity',
    );
    expect(screen.getByTestId('ai-insights-total').textContent).toBe('3');
    // The header holds the count and View All, with no extra icon and no footer.
    const header = screen.getByTestId('ai-insights-total').parentElement as HTMLElement;
    expect(within(header).getByTestId('ai-insights-view-all')).toBeTruthy();
    expect(header.querySelector('svg')).toBeNull();
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

  it('TC-AI-IA-07 shows no insights while AI Insights are off, even when some are still active', async () => {
    features.aiInsightsEnabled = false;
    serve([insight()]);
    wrap(<ActiveInsightsWidget />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/portal/features');
    });
    expect(screen.queryByTestId('ai-active-insights')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringContaining('/v1/ai/insights'));
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
      expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights/ins1?language=en&feedback=true');
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
      '/ai/insights?status=open&siteId=site1&category=connectivity',
    );
    const row = await screen.findByTestId('ai-insight-list-row');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?status=open&category=connectivity&siteId=site1&limit=20&language=en&page=1',
    );
    expect(within(row).getByText('CS-1616')).toBeTruthy();
    expect(within(row).getByText('aiInsights.status.open')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('aiInsights.list.kind'), {
      target: { value: 'station_faulted' },
    });
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenLastCalledWith(
        '/v1/ai/insights?status=open&kind=station_faulted&category=connectivity&siteId=site1&limit=20&language=en&page=1',
      );
    });
    fireEvent.click((await screen.findAllByTestId('ai-insight-list-row'))[0] as HTMLElement);
    expect(await screen.findByText('insight page')).toBeTruthy();
  });

  it('lists the reservation kinds in the kind filter only while reservations are on', async () => {
    const options = (): string[] =>
      Array.from((document.getElementById('ai-insights-kind') as HTMLSelectElement).options).map(
        (o) => o.value,
      );
    try {
      serve([]);
      wrap(
        <Routes>
          <Route path="/ai/insights" element={<AiInsights />} />
        </Routes>,
        '/ai/insights',
      );
      await waitFor(() => {
        expect(options()).toContain('reservation_rejected');
      });
      cleanup();
      features.reservationEnabled = false;
      serve([]);
      wrap(
        <Routes>
          <Route path="/ai/insights" element={<AiInsights />} />
        </Routes>,
        '/ai/insights?kind=reservation_no_show',
      );
      await waitFor(() => {
        expect(apiMock.get).toHaveBeenCalledWith('/v1/portal/features');
        expect(options()).not.toContain('reservation_rejected');
      });
      expect(options()).toContain('station_offline');
      expect(options().some((o) => o.startsWith('reservation_'))).toBe(false);
    } finally {
      features.reservationEnabled = true;
    }
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
    expect(screen.getByTestId('ai-insight-status').textContent).toBe('aiInsights.status.open');
    expect(screen.getByTestId('ai-insight-card')).toBeTruthy();
    expect(screen.getByText('CS-1616').closest('a')?.getAttribute('href')).toBe('/stations/st1');
    expect(screen.getByText('se1').closest('a')?.getAttribute('href')).toBe('/sessions/se1');
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/audit/ai_insight/ins1?page=1&limit=20');
    });
  });
});

describe('insight feedback views', () => {
  it('TC-AI-FB-UI-06 the list filters insights marked wrong from the URL and the Feedback select', async () => {
    serve([insight()]);
    wrap(
      <Routes>
        <Route path="/ai/insights" element={<AiInsights />} />
      </Routes>,
      '/ai/insights?feedback=wrong',
    );
    await screen.findByTestId('ai-insight-list-row');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?feedback=wrong&limit=20&language=en&page=1',
    );
    const select = screen.getByLabelText<HTMLSelectElement>('aiInsights.list.feedback');
    expect(select.value).toBe('wrong');
    fireEvent.change(select, { target: { value: 'helpful' } });
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenLastCalledWith(
        '/v1/ai/insights?feedback=helpful&limit=20&language=en&page=1',
      );
    });
  });

  it('TC-AI-FB-UI-07 the quality card shows the helpful rate by kind and links the wrong ones', async () => {
    apiMock.get.mockResolvedValue({
      days: 30,
      data: [
        { kind: 'station_offline', helpful: 3, wrong: 1 },
        { kind: 'session_failed', helpful: 2, wrong: 0 },
      ],
    });
    wrap(<InsightQualityCard />);
    const rows = await screen.findAllByTestId('ai-insight-quality-row');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights/feedback-summary');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('aiInsights.kind.station_offline');
    expect(rows[0]?.textContent).toContain('75%');
    expect(rows[1]?.textContent).toContain('100%');
    expect(
      screen
        .getByRole('link', { name: 'settings.aiInsightsSettings.quality.viewWrong' })
        .getAttribute('href'),
    ).toBe('/ai/insights?feedback=wrong');
  });

  it('TC-AI-FB-UI-07 the quality card says when there are no votes, and is hidden without aiInsights:read', async () => {
    apiMock.get.mockResolvedValue({ days: 30, data: [] });
    wrap(<InsightQualityCard />);
    expect((await screen.findByTestId('ai-insight-quality-empty')).textContent).toBe(
      'settings.aiInsightsSettings.quality.empty(30)',
    );
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    perms.clear();
    wrap(<InsightQualityCard />);
    expect(screen.queryByTestId('ai-insight-quality')).toBeNull();
  });
});
