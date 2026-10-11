// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { AiInsightView } from '../insights/insight-api';

const { apiMock, perms, status } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn() },
  perms: new Set<string>(),
  status: { chatbot: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { count?: number }) =>
      o?.count != null ? `${key}:${String(o.count)}` : key,
    i18n: { language: 'ko' },
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  formatRelativeTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('../use-ai-status', () => ({
  useAiStatus: () => ({ chatbot: status.chatbot, support: false, isLoading: false }),
}));

import { InsightCard } from '../insights/InsightCard';
import { RecordInsight } from '../insights/RecordInsight';
import { SupportCaseInsights } from '../insights/SupportCaseInsights';
import { AuthorizeInsightCell } from '../insights/AuthorizeInsightCell';
import { pickShownInsight, useAuthorizationInsights } from '../insights/insight-api';
import { ExplainButton } from '../ExplainButton';
import { useAiPanelStore } from '../use-ai-panel-store';

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
    scope: { site: { stationsOffline: 3, stations: 0 } },
    generatedBy: 'model',
    language: 'ko',
    summary: '네트워크 연결이 끊겼습니다.',
    textStatus: 'ready',
    originalSummary: 'The network connection dropped.',
    stale: false,
    basisAt: '2026-10-10T10:00:00Z',
    createdAt: '2026-10-10T10:00:00Z',
    resolvedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function wrap(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
  perms.add('aiInsights:read');
  status.chatbot = true;
  useAiPanelStore.setState({ open: false, request: null, returnFocus: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InsightCard', () => {
  it('TC-AI-IN-UI-05: renders category, confidence, fixes and scope through locale keys, the summary as plain text', () => {
    wrap(
      <InsightCard
        insight={insight({ summary: '<b>Reboot</b> [link](https://x.example)' })}
        onFollowUp={undefined}
      />,
    );
    expect(screen.getByTestId('ai-insight-category').textContent).toBe(
      'aiInsights.category.connectivity',
    );
    expect(screen.getByText('aiInsights.confidenceBadge.high')).toBeTruthy();
    expect(screen.getByText('aiInsights.fix.check_network_connection')).toBeTruthy();
    // The scope is collapsed by default; its trigger names the main measure at detection.
    expect(screen.queryByTestId('ai-insight-scope')).toBeNull();
    expect(screen.getByTestId('ai-insight-scope-section').textContent).toContain(
      'aiInsights.scopeTable.summaryAtDetection',
    );
    // Model text is plain text: no HTML, no link.
    const summary = screen.getByTestId('ai-insight-summary');
    expect(summary.textContent).toBe('<b>Reboot</b> [link](https://x.example)');
    expect(summary.querySelector('a, b')).toBeNull();
    // D14: no provider or model name.
    expect(document.body.textContent).not.toMatch(/anthropic|openai|gemini|deepseek|claude|gpt/i);
  });

  it('shows the canonical text while the translation is pending, then the translation with Show original', () => {
    wrap(<InsightCard insight={insight({ summary: null, textStatus: 'pending' })} />);
    expect(screen.getByTestId('ai-insight-translating')).toBeTruthy();
    expect(screen.getByTestId('ai-insight-summary').textContent).toBe(
      'The network connection dropped.',
    );
    expect(screen.queryByRole('button', { name: 'aiInsights.showOriginal' })).toBeNull();
    cleanup();
    wrap(<InsightCard insight={insight()} />);
    expect(screen.queryByTestId('ai-insight-translating')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'aiInsights.showOriginal' }));
    expect(screen.getByTestId('ai-insight-summary').textContent).toBe(
      'The network connection dropped.',
    );
  });

  it('TC-AI-IN-UI-06: an out-of-date insight shows its badge and, with aiInsights:write, Regenerate', async () => {
    perms.add('aiInsights:write');
    apiMock.post.mockResolvedValue({ id: 'ins2' });
    wrap(<InsightCard insight={insight({ stale: true })} />);
    expect(screen.getByTestId('ai-insight-stale')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-insight-regenerate'));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/insights/ins1/regenerate', {});
    });
    expect(await screen.findByText('aiInsights.regenerateQueued')).toBeTruthy();
  });

  it('TC-AI-IN-UI-06: a regenerate refusal shows inline on the card, not in a toast', async () => {
    perms.add('aiInsights:write');
    const { ApiError } = await import('@/lib/api');
    apiMock.post.mockRejectedValue(
      new ApiError(429, { error: 'cooldown', code: 'AI_INSIGHT_COOLDOWN' }),
    );
    wrap(
      <InsightCard insight={insight({ status: 'resolved', resolvedAt: '2026-10-10T11:00:00Z' })} />,
    );
    expect(screen.getByTestId('ai-insight-resolved')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-insight-regenerate'));
    // getErrorMessage maps the code to errors.AI_INSIGHT_COOLDOWN (the test t has no translations).
    expect(
      (await screen.findByRole('alert')).closest('[data-testid="ai-insight-card"]'),
    ).toBeTruthy();
  });

  it('clears "being prepared" once the insight changes', async () => {
    perms.add('aiInsights:write');
    apiMock.post.mockResolvedValue({ id: 'ins2' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (i: AiInsightView) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InsightCard insight={i} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(view(insight({ stale: true })));
    fireEvent.click(screen.getByTestId('ai-insight-regenerate'));
    expect(await screen.findByText('aiInsights.regenerateQueued')).toBeTruthy();
    rerender(view(insight({ stale: false, basisAt: '2026-10-10T11:00:00Z' })));
    await waitFor(() => {
      expect(screen.queryByText('aiInsights.regenerateQueued')).toBeNull();
    });
  });

  it('renders worker summaries and tariff findings by kind, without a root cause for summaries', () => {
    wrap(
      <InsightCard
        insight={insight({
          kind: 'site_summary',
          category: 'unknown',
          fixes: [],
          scope: {},
          summary: null,
          originalSummary: null,
          textStatus: 'unavailable',
          generatedBy: 'rule',
        })}
      />,
    );
    expect(screen.getByTestId('ai-insight-headline').textContent).toBe(
      'aiInsights.headline.site_summary',
    );
    expect(screen.queryByTestId('ai-insight-category')).toBeNull();
    expect(screen.queryByTestId('ai-insight-translating')).toBeNull();
    cleanup();
    wrap(
      <InsightCard
        insight={insight({
          kind: 'tariff_anomaly',
          category: 'tariff',
          fixes: [{ code: 'review_tariff_assignment' }],
          scope: {},
        })}
      />,
    );
    expect(screen.getByTestId('ai-insight-headline').textContent).toBe(
      'aiInsights.headline.tariff_anomaly',
    );
    expect(screen.getByTestId('ai-insight-category').textContent).toBe(
      'aiInsights.category.tariff',
    );
    expect(screen.getByText('aiInsights.fix.review_tariff_assignment')).toBeTruthy();
  });

  it('an analyzing insight shows a skeleton of the card, never an empty box', () => {
    wrap(<InsightCard insight={insight({ status: 'pending', summary: null })} />);
    const card = screen.getByTestId('ai-insight-card');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'aiInsights.status.pending' })).toBeTruthy();
    expect(screen.queryByTestId('ai-insight-summary')).toBeNull();
  });

  it('a skipped or failed insight shows one muted line with the reason and Regenerate', () => {
    perms.add('aiInsights:write');
    wrap(<InsightCard insight={insight({ status: 'skipped', skipReason: 'budget_exceeded' })} />);
    expect(screen.getByTestId('ai-insight-brief').textContent).toBe('aiInsights.skippedNote');
    expect(screen.queryByTestId('ai-insight-summary')).toBeNull();
    expect(screen.getByTestId('ai-insight-regenerate')).toBeTruthy();
    cleanup();
    wrap(<InsightCard insight={insight({ status: 'failed' })} />);
    expect(screen.getByTestId('ai-insight-brief').textContent).toBe('aiInsights.failedNote');
  });

  it('builds the headline and the accent from the kind, and links a fix to its station tab', () => {
    wrap(
      <InsightCard
        insight={insight({ kind: 'station_faulted', fixes: [{ code: 'update_firmware' }] })}
      />,
    );
    const card = screen.getByTestId('ai-insight-card');
    expect(card.className).toContain('border-l-destructive');
    expect(screen.getByTestId('ai-insight-headline').textContent).toBe(
      'aiInsights.headline.station_faulted',
    );
    expect(
      screen.getByRole('link', { name: 'aiInsights.fix.update_firmware' }).getAttribute('href'),
    ).toBe('/stations/st1?tab=firmware-history');
  });

  it('hides regenerate, dismiss and feedback without aiInsights:write', () => {
    wrap(<InsightCard insight={insight({ stale: true })} />);
    expect(screen.queryByTestId('ai-insight-regenerate')).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiInsights.dismiss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiInsights.helpful' })).toBeNull();
  });

  it('feedback posts helpful and thanks the user', async () => {
    perms.add('aiInsights:write');
    apiMock.post.mockResolvedValue({});
    wrap(<InsightCard insight={insight()} />);
    fireEvent.click(screen.getByRole('button', { name: 'aiInsights.wrong' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/insights/ins1/feedback', {
        helpful: false,
      });
    });
    expect(await screen.findByText('aiInsights.feedbackThanks')).toBeTruthy();
  });
});

describe('pickShownInsight', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('prefers an active or analyzing insight, else one resolved within a day', () => {
    const resolved = insight({ id: 'r', status: 'resolved', resolvedAt: '2026-10-10T08:00:00Z' });
    const old = insight({ id: 'o', status: 'resolved', resolvedAt: '2026-10-08T08:00:00Z' });
    expect(pickShownInsight([resolved, insight({ id: 'a' })], now)?.id).toBe('a');
    expect(pickShownInsight([resolved], now)?.id).toBe('r');
    expect(pickShownInsight([old], now)).toBeUndefined();
    expect(pickShownInsight([insight({ status: 'dismissed' })], now)).toBeUndefined();
  });
});

describe('record pages', () => {
  it('TC-AI-IN-UI-01: the station card asks for the station insights in the UI language', async () => {
    apiMock.get.mockResolvedValue({ data: [insight()], total: 1 });
    wrap(<RecordInsight filter={{ stationId: 'st1' }} context={{ kind: 'station', id: 'st1' }} />);
    expect(await screen.findByTestId('ai-insight-card')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights?stationId=st1&limit=10&language=ko');
  });

  it('TC-AI-IN-UI-02: the session card renders nothing without an insight to show', async () => {
    apiMock.get.mockResolvedValue({ data: [insight({ status: 'skipped' })], total: 1 });
    wrap(<RecordInsight filter={{ sessionId: 'se1' }} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        '/v1/ai/insights?sessionId=se1&limit=10&language=ko',
      );
    });
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
  });

  it('renders nothing and asks nothing without aiInsights:read', () => {
    perms.clear();
    wrap(<RecordInsight filter={{ stationId: 'st1' }} />);
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
  });

  it('TC-AI-IN-UI-03: the support case panel reads the case insights (server-scoped) and shows at most three', async () => {
    apiMock.get.mockResolvedValue({
      data: [1, 2, 3, 4].map((n) => insight({ id: `i${String(n)}`, sessionId: `se${String(n)}` })),
      total: 4,
    });
    wrap(<SupportCaseInsights caseId="case1" />);
    expect(await screen.findAllByTestId('ai-insight-card')).toHaveLength(3);
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?supportCaseId=case1&limit=10&language=ko',
    );
  });

  it('TC-AI-IN-UI-04: a refused authorize row with an insight opens it; without one it offers Explain', async () => {
    perms.add('aiAssistant:write');
    wrap(
      <>
        <AuthorizeInsightCell
          attemptId={7}
          insight={insight({ kind: 'authorization_refused', authorizeAttemptId: 7 })}
        />
        <AuthorizeInsightCell attemptId={8} insight={undefined} />
      </>,
    );
    fireEvent.click(screen.getByTestId('ai-insight-icon'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('ai-insight-card')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-insight-follow-up'));
    expect(useAiPanelStore.getState().request?.context).toEqual({
      kind: 'authorization',
      id: '7',
    });
    expect(useAiPanelStore.getState().request?.insightId).toBeNull();
    fireEvent.click(screen.getByTestId('ai-explain'));
    expect(useAiPanelStore.getState().request?.context).toEqual({
      kind: 'authorization',
      id: '8',
    });
  });

  it('TC-AI-IN-UI-04: the authorize log asks for the insights of its refused rows and maps grouped ones to every row', async () => {
    apiMock.get.mockResolvedValue({
      data: [
        insight({
          kind: 'authorization_refused',
          authorizeAttemptId: 7,
          matchedAttemptIds: [7, 9],
        }),
      ],
      total: 1,
    });
    function Probe(): React.JSX.Element {
      const map = useAuthorizationInsights([9, 7, 7]);
      return <p data-testid="map">{[...map.keys()].sort().join(',')}</p>;
    }
    wrap(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('map').textContent).toBe('7,9');
    });
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?authorizeAttemptIds=7%2C9&status=active&limit=100&language=ko',
    );
  });

  it('asks nothing for a log page without refused rows', () => {
    function Probe(): React.JSX.Element {
      useAuthorizationInsights([]);
      return <p />;
    }
    wrap(<Probe />);
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});

describe('ExplainButton (TC-AI-EX-05)', () => {
  it('shows with the assistant on and aiAssistant:write, and opens the panel about the record', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    wrap(<ExplainButton context={{ kind: 'session', id: 'se1' }} />);
    fireEvent.click(await screen.findByTestId('ai-explain'));
    const state = useAiPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.request).toMatchObject({
      context: { kind: 'session', id: 'se1' },
      insightId: null,
    });
  });

  it('TC-AI-EX-04: opens the fresh insight instead of a conversation', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [insight({ id: 'fresh' })], total: 1 });
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByTestId('ai-explain'));
    expect(useAiPanelStore.getState().request?.insightId).toBe('fresh');
  });

  it('a stale insight is not fresh: Explain asks the question instead', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [insight({ stale: true })], total: 1 });
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId('ai-explain'));
    expect(useAiPanelStore.getState().request?.insightId).toBeNull();
  });

  it('is hidden without aiAssistant:write', () => {
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} />);
    expect(screen.queryByTestId('ai-explain')).toBeNull();
  });

  it('is hidden while the assistant is off', () => {
    perms.add('aiAssistant:write');
    status.chatbot = false;
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} />);
    expect(screen.queryByTestId('ai-explain')).toBeNull();
  });
});
