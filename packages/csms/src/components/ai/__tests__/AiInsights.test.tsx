// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { AiInsightView } from '../insights/insight-api';

const { apiMock, perms, status } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
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
import { RecordInsightsTab } from '../insights/RecordInsightsTab';
import { SupportCaseInsights } from '../insights/SupportCaseInsights';
import { AuthorizeInsightCell } from '../insights/AuthorizeInsightCell';
import { pickShownInsight, useAuthorizationInsights } from '../insights/insight-api';
import { ExplainButton } from '../ExplainButton';
import { useAiPanelStore } from '../use-ai-panel-store';

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
    action: null,
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
  it('TC-AI-IN-UI-05: renders category, confidence and fixes through locale keys, the summary as plain text', () => {
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
    // No Site Context section: the card shows no scope table or summary.
    expect(screen.queryByTestId('ai-insight-scope-section')).toBeNull();
    expect(screen.queryByTestId('ai-insight-scope')).toBeNull();
    // Model text is plain text: no HTML, no link.
    const summary = screen.getByTestId('ai-insight-summary');
    expect(summary.textContent).toBe('<b>Reboot</b> [link](https://x.example)');
    expect(summary.querySelector('a, b')).toBeNull();
    // D14: no provider or model name.
    // Locale keys run together in the test text ("status.open" + "aiInsights"): drop them first.
    const shown = document.body.textContent.replace(/aiInsights\.[\w.]+/g, ' ');
    expect(shown).not.toMatch(/anthropic|openai|gemini|deepseek|claude|gpt/i);
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
    expect(screen.getByTestId('ai-insight-status').textContent).toBe('aiInsights.status.resolved');
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
    wrap(<InsightCard insight={insight({ status: 'analyzing', summary: null })} />);
    const card = screen.getByTestId('ai-insight-card');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'aiInsights.analyzing' })).toBeTruthy();
    // An internal state never shows as a badge.
    expect(screen.queryByTestId('ai-insight-status')).toBeNull();
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

  it('builds the headline and the accent from the kind, and shows a fix as plain text', () => {
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
    // One Suggested Fix section; a step is text, never a link.
    const fix = screen.getByTestId('ai-insight-fix');
    expect(within(fix).getByText('aiInsights.fixesLabel')).toBeTruthy();
    expect(within(fix).getByText('aiInsights.fix.update_firmware')).toBeTruthy();
    expect(within(fix).queryByRole('link')).toBeNull();
  });

  it('hides regenerate, dismiss and feedback without aiInsights:write', () => {
    wrap(<InsightCard insight={insight({ stale: true })} />);
    expect(screen.queryByTestId('ai-insight-regenerate')).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiInsights.dismiss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiInsights.helpful' })).toBeNull();
  });

  it('TC-AI-FB-UI-01 the chosen thumb is pressed and the helpful count shows', () => {
    perms.add('aiInsights:write');
    wrap(
      <InsightCard
        insight={insight({ feedback: { helpfulCount: 3, wrongCount: 1, mine: true } })}
      />,
    );
    const helpful = screen.getByRole('button', { name: 'aiInsights.helpful' });
    const wrong = screen.getByRole('button', { name: 'aiInsights.wrong' });
    expect(helpful.getAttribute('aria-pressed')).toBe('true');
    expect(wrong.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('ai-insight-helpful-count').textContent).toBe(
      'aiInsights.feedback.helpfulCount:3',
    );
  });

  it('TC-AI-FB-UI-02 pressing the chosen thumb again removes the vote', async () => {
    perms.add('aiInsights:write');
    apiMock.delete.mockResolvedValue(undefined);
    wrap(
      <InsightCard
        insight={insight({ feedback: { helpfulCount: 1, wrongCount: 0, mine: true } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'aiInsights.helpful' }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/ai/insights/ins1/feedback');
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('TC-AI-FB-UI-03 Wrong opens an optional note with Regenerate and Dismiss; the note is posted with the vote', async () => {
    perms.add('aiInsights:write');
    apiMock.post.mockResolvedValue({});
    wrap(
      <InsightCard
        insight={insight({ feedback: { helpfulCount: 0, wrongCount: 0, mine: null } })}
      />,
    );
    expect(screen.queryByTestId('ai-insight-helpful-count')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'aiInsights.wrong' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/insights/ins1/feedback', {
        helpful: false,
      });
    });
    const panel = screen.getByTestId('ai-insight-wrong-panel');
    expect(panel.textContent).toContain('aiInsights.feedback.wrongPrompt');
    expect(panel.textContent).toContain('aiInsights.feedback.reasonHint');
    const reason = screen.getByLabelText('aiInsights.feedback.reasonLabel');
    expect(reason.getAttribute('maxLength')).toBe('500');
    expect(screen.getByTestId('ai-insight-wrong-regenerate')).toBeTruthy();
    expect(screen.getByTestId('ai-insight-wrong-dismiss')).toBeTruthy();
    fireEvent.change(reason, { target: { value: 'Planned maintenance' } });
    fireEvent.click(screen.getByTestId('ai-insight-wrong-save'));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenLastCalledWith('/v1/ai/insights/ins1/feedback', {
        helpful: false,
        reason: 'Planned maintenance',
      });
    });
    expect(await screen.findByText('aiInsights.feedback.reasonSaved')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-insight-wrong-regenerate'));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenLastCalledWith('/v1/ai/insights/ins1/regenerate', {});
    });
  });

  it('TC-AI-FB-UI-04 a reader sees the helpful count but no vote buttons or note', () => {
    wrap(
      <InsightCard
        insight={insight({ feedback: { helpfulCount: 2, wrongCount: 0, mine: null } })}
      />,
    );
    expect(screen.getByTestId('ai-insight-helpful-count')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'aiInsights.wrong' })).toBeNull();
    expect(screen.queryByTestId('ai-insight-wrong-panel')).toBeNull();
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
    const onOpen = vi.fn();
    wrap(<RecordInsight filter={{ stationId: 'st1' }} onOpen={onOpen} />);
    // A floating icon pulses while the insight is open and opens the page's AI Insights tab.
    expect(await screen.findByTestId('record-insight-pulse')).toBeTruthy();
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
    fireEvent.click(screen.getByTestId('record-insight-trigger'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights?stationId=st1&limit=10&language=ko');
  });

  it('TC-AI-IN-UI-02: the session card renders nothing without an insight to show', async () => {
    apiMock.get.mockResolvedValue({ data: [insight({ status: 'skipped' })], total: 1 });
    wrap(<RecordInsight filter={{ sessionId: 'se1' }} onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        '/v1/ai/insights?sessionId=se1&limit=10&language=ko',
      );
    });
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
  });

  it('renders nothing and asks nothing without aiInsights:read', () => {
    perms.clear();
    wrap(<RecordInsight filter={{ stationId: 'st1' }} onOpen={vi.fn()} />);
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
          stationOcppId="CS-7"
          insight={insight({ kind: 'authorization_refused', authorizeAttemptId: 7 })}
        />
        <AuthorizeInsightCell attemptId={8} stationOcppId="CS-8" insight={undefined} />
      </>,
    );
    fireEvent.click(screen.getByTestId('ai-insight-icon'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('ai-insight-card')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-insight-follow-up'));
    expect(useAiPanelStore.getState().request?.context).toEqual({
      kind: 'authorization',
      id: '7',
      label: 'CS-7',
    });
    fireEvent.click(screen.getByTestId('ai-explain'));
    expect(useAiPanelStore.getState().request?.context).toEqual({
      kind: 'authorization',
      id: '8',
      label: 'CS-8',
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
      '/v1/ai/insights?authorizeAttemptIds=7%2C9&status=open&limit=100&language=ko',
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
    expect(state.request?.context).toEqual({ kind: 'session', id: 'se1' });
    // Only the record: the panel never receives an insight to show.
    expect(Object.keys(state.request ?? {}).sort()).toEqual(['context', 'seq']);
  });

  it('TC-AI-EX-04: a fresh insight marks the icon; the panel opens about the record only', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [insight({ id: 'fresh' })], total: 1 });
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} iconOnly />);
    fireEvent.click(await screen.findByTestId('ai-insight-icon'));
    expect(useAiPanelStore.getState().request?.context).toEqual({ kind: 'station', id: 'st1' });
    expect(Object.keys(useAiPanelStore.getState().request ?? {}).sort()).toEqual([
      'context',
      'seq',
    ]);
  });

  it('a stale insight is not fresh: the icon is the Explain one', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [insight({ stale: true })], total: 1 });
    wrap(<ExplainButton context={{ kind: 'station', id: 'st1' }} iconOnly />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.getByTestId('ai-explain')).toBeTruthy();
    expect(screen.queryByTestId('ai-insight-icon')).toBeNull();
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

describe('reservation insights', () => {
  const reservationInsight = (overrides: Partial<AiInsightView> = {}): AiInsightView =>
    insight({
      id: 'rins1',
      kind: 'reservation_cancel_failed',
      reservationId: 'res1',
      category: 'connectivity',
      fixes: [
        { code: 'reservation_retry_cancel' },
        { code: 'reservation_review_fee_payment' },
        { code: 'reservation_check_station_connectivity' },
      ],
      scope: { site: { stations: 2 } },
      ...overrides,
    });

  it('TC-AI-RI-UI-01 the reservation page card reads the reservation insights and shows one', async () => {
    apiMock.get.mockResolvedValue({ data: [reservationInsight()], total: 1 });
    wrap(<RecordInsightsTab filter={{ reservationId: 'res1' }} />);
    // The AI Insights tab lists the reservation's insights; a row opens the insight page.
    expect(await screen.findByTestId(`record-insight-row-${reservationInsight().id}`)).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/insights?reservationId=res1&limit=10&language=ko',
    );
  });

  it('TC-AI-RI-UI-01 renders nothing for a reservation without an insight', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    wrap(<RecordInsight filter={{ reservationId: 'res1' }} onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
  });

  it('TC-AI-RI-UI-03 renders the headline, category and fixes through locale keys', () => {
    wrap(<InsightCard insight={reservationInsight()} />);
    expect(screen.getByTestId('ai-insight-headline').textContent).toBe(
      'aiInsights.headline.reservation_cancel_failed',
    );
    expect(screen.getByTestId('ai-insight-category').textContent).toBe(
      'aiInsights.category.connectivity',
    );
    expect(screen.getByText('aiInsights.fix.reservation_check_station_connectivity')).toBeTruthy();
  });

  it('TC-AI-RI-UI-04 reservation fixes show as plain steps, never links', () => {
    wrap(<InsightCard insight={reservationInsight()} />);
    const fix = screen.getByTestId('ai-insight-fix');
    expect(within(fix).getByText('aiInsights.fix.reservation_retry_cancel')).toBeTruthy();
    expect(within(fix).getByText('aiInsights.fix.reservation_review_fee_payment')).toBeTruthy();
    expect(within(fix).queryByRole('link')).toBeNull();
  });

  it('Explain on a reservation looks up the reservation insight', async () => {
    perms.add('aiAssistant:write');
    apiMock.get.mockResolvedValue({ data: [reservationInsight({ id: 'fresh' })], total: 1 });
    wrap(<ExplainButton context={{ kind: 'reservation', id: 'res1' }} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        '/v1/ai/insights?reservationId=res1&limit=10&language=ko',
      );
    });
    fireEvent.click(await screen.findByTestId('ai-explain'));
    expect(useAiPanelStore.getState().request?.context).toEqual({
      kind: 'reservation',
      id: 'res1',
    });
  });
});
