// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AiInsightActionView, AiInsightView } from '../insights/insight-api';

const { apiMock, perms, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  perms: new Set<string>(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasAllSiteAccess: () => true,
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  formatRelativeTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn() }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '@/lib/api';
import { InsightActionSection } from '../insights/InsightAction';
import { InsightCard } from '../insights/InsightCard';
import { actionToolName, isActionOpen, readActionSummary } from '../insights/insight-action';
import { AiInsightDetail } from '@/pages/AiInsightDetail';

const FUTURE = '2099-01-01T00:00:00Z';

function action(overrides: Partial<AiInsightActionView> = {}): AiInsightActionView {
  return {
    id: 'p1',
    job: 'stuck_sessions',
    insightId: 'ins1',
    siteId: 'site1',
    stationId: 'st-db-1',
    sessionId: 'se1',
    operationId: 'ocppv21_RequestStopTransaction',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/RequestStopTransaction',
    args: { stationId: 'CS-1', transactionId: 'tx-9' },
    argsHash: 'hash-1',
    summary: {
      action: 'stop_transaction',
      transactionId: 'tx-9',
      lastActivityAt: '2026-10-10T08:00:00Z',
      rationale: { code: 'stuckSessionIdle', params: { minutes: 95 } },
    },
    precondition: { kind: 'session_active', params: { sessionId: 'se1' } },
    status: 'pending',
    expiresAt: FUTURE,
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
    result: null,
    createdAt: '2026-10-10T10:00:00Z',
    ...overrides,
  };
}

function insight(overrides: Partial<AiInsightView> = {}): AiInsightView {
  return {
    id: 'ins1',
    kind: 'stuck_session',
    status: 'active',
    skipReason: null,
    siteId: 'site1',
    stationId: 'st-db-1',
    sessionId: 'se1',
    authorizeAttemptId: null,
    reservationId: null,
    parentInsightId: null,
    category: 'unknown',
    confidence: 'medium',
    fixes: [{ code: 'monitor' }],
    scope: {},
    generatedBy: 'rule',
    language: 'en',
    summary: null,
    textStatus: 'unavailable',
    stale: false,
    basisAt: '2026-10-10T10:00:00Z',
    createdAt: '2026-10-10T10:00:00Z',
    resolvedAt: null,
    dismissedAt: null,
    action: action(),
    stationName: 'CS-1',
    siteName: 'Convention Center',
    ...overrides,
  };
}

function wrap(ui: React.ReactNode, path = '/'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function confirmInDialog(label: string): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
}

beforeEach(() => {
  perms.clear();
  perms.add('aiInsights:read');
  perms.add('aiInsights:write');
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes('/neighbors') ? { prevId: 'ins0', nextId: 'ins2' } : insight()),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Insight action (AI Inbox merged into AI Insights)', () => {
  it('TC-AI-WK-UI-02: leads with the localized sentence, the action, the rationale and the measured values', () => {
    wrap(<InsightActionSection insight={insight()} />);
    const section = screen.getByTestId('ai-insight-action');
    expect(screen.getByTestId('ai-insight-action-summary').textContent).toBe(
      'ai.confirmAction.stop(CS-1,tx-9)',
    );
    expect(within(section).getAllByText('aiInsights.action.kind.stop_transaction')).toHaveLength(1);
    expect(screen.getByTestId('ai-insight-action-status').textContent).toBe(
      'aiInsights.action.status.pending',
    );
    expect(screen.getByTestId('ai-insight-action-rationale').textContent).toBe(
      'aiWorkers.rationale.stuckSessionIdle(95)',
    );
    expect(within(section).getByText('aiInsights.action.measured.minutes(95)')).toBeTruthy();
    expect(within(section).getByText('2026-10-10T08:00:00Z')).toBeTruthy();
    expect(within(section).getByText('aiInsights.action.precondition.session_active')).toBeTruthy();
  });

  it('item 15: the full arguments use the shared copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    wrap(<InsightActionSection insight={insight()} />);
    const args = screen.getByTestId('ai-insight-action-arguments');
    const copy = within(args).getByTestId('copy-button');
    fireEvent.click(copy);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify({ stationId: 'CS-1', transactionId: 'tx-9' }, null, 2),
      );
    });
  });

  it('item 16: Reject and Confirm sit right-aligned', () => {
    wrap(<InsightActionSection insight={insight()} />);
    const row = screen.getByTestId('ai-action-buttons');
    expect(row.className).toContain('justify-end');
    expect(within(row).getByTestId('ai-action-reject')).toBeTruthy();
    expect(within(row).getByTestId('ai-action-confirm')).toBeTruthy();
  });

  it('TC-AI-WK-UI-02: Confirm asks in the standard dialog, then sends the argsHash shown and raises a toast', async () => {
    apiMock.post.mockResolvedValue(
      insight({ action: action({ status: 'executed', result: { httpStatus: 200 } }) }),
    );
    wrap(<InsightActionSection insight={insight()} />);
    fireEvent.click(screen.getByTestId('ai-action-confirm'));
    expect(apiMock.post).not.toHaveBeenCalled();
    await confirmInDialog('aiInsights.action.confirm');
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/insights/ins1/action/confirm', {
        argsHash: 'hash-1',
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'aiInsights.action.executed',
      });
    });
  });

  it('Reject asks in the standard dialog, then posts to the reject endpoint', async () => {
    apiMock.post.mockResolvedValue(insight({ action: action({ status: 'rejected' }) }));
    wrap(<InsightActionSection insight={insight()} />);
    fireEvent.click(screen.getByTestId('ai-action-reject'));
    await confirmInDialog('aiInsights.action.reject');
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/insights/ins1/action/reject', {});
    });
  });

  it('a stale action shows its refusal inline, not in a toast', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(409, { error: 'stale', code: 'AI_PROPOSAL_STALE' }),
    );
    wrap(<InsightActionSection insight={insight()} />);
    fireEvent.click(screen.getByTestId('ai-action-confirm'));
    await confirmInDialog('aiInsights.action.confirm');
    const alert = await screen.findByTestId('ai-action-error');
    expect(alert.closest('[data-testid="ai-insight-action"]')).toBeTruthy();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('hides Confirm and Reject without aiInsights:write, after a decision, and once expired', () => {
    perms.delete('aiInsights:write');
    wrap(<InsightActionSection insight={insight()} />);
    expect(screen.queryByTestId('ai-action-confirm')).toBeNull();
    cleanup();
    perms.add('aiInsights:write');
    wrap(
      <InsightActionSection
        insight={insight({ action: action({ status: 'executed', result: { httpStatus: 200 } }) })}
      />,
    );
    expect(screen.queryByTestId('ai-action-confirm')).toBeNull();
    expect(screen.getByText('aiInsights.action.executed (HTTP 200)')).toBeTruthy();
    cleanup();
    wrap(
      <InsightActionSection
        insight={insight({ action: action({ expiresAt: '2020-01-01T00:00:00Z' }) })}
      />,
    );
    expect(screen.queryByTestId('ai-action-confirm')).toBeNull();
  });

  it('localizes a refusal reason and shows no stored text', () => {
    wrap(
      <InsightActionSection
        insight={insight({
          action: action({
            status: 'failed',
            result: { httpStatus: 0, body: { refused: 'ocpp_version_mismatch' } },
          }),
        })}
      />,
    );
    expect(screen.getByTestId('ai-insight-action-refusal').textContent).toBe(
      'aiInsights.action.refused.ocpp_version_mismatch',
    );
  });

  it('shows nothing for an insight without an action', () => {
    wrap(<InsightActionSection insight={insight({ action: null })} />);
    expect(screen.queryByTestId('ai-insight-action')).toBeNull();
  });

  it('the insight card hides Dismiss and Regenerate while the action waits', async () => {
    wrap(<InsightCard insight={insight()} />);
    expect(await screen.findByTestId('ai-insight-action')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aiInsights\.dismiss/ })).toBeNull();
    expect(screen.queryByTestId('ai-insight-regenerate')).toBeNull();
  });

  it('item 14: the insight page has Prev and Next, the action history and its job', async () => {
    perms.add('audit:read');
    wrap(
      <Routes>
        <Route path="/ai/insights/:id" element={<AiInsightDetail />} />
      </Routes>,
      '/ai/insights/ins1',
    );
    expect(await screen.findByTestId('ai-insight-action')).toBeTruthy();
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights/ins1/neighbors');
    });
    expect(screen.getByText('aiInsights.action.job.stuck_sessions')).toBeTruthy();
    expect(await screen.findByText('aiInsights.action.history')).toBeTruthy();
  });

  it('reads only known summary values and maps operation ids to tool names', () => {
    expect(
      readActionSummary({ action: 'drop_tables', rationale: { code: '<script>' } }),
    ).toMatchObject({ action: null, rationale: null });
    expect(actionToolName('ocppv21_RequestStopTransaction')).toBe(
      'ocppv21_request_stop_transaction',
    );
    expect(isActionOpen({ status: 'pending', expiresAt: FUTURE })).toBe(true);
    expect(isActionOpen({ status: 'rejected', expiresAt: FUTURE })).toBe(false);
  });
});
