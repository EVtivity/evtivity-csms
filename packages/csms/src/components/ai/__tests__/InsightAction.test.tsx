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
import {
  actionToolName,
  actionTransactionId,
  isActionOpen,
  readActionSummary,
} from '../insights/insight-action';
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
    status: 'pending',
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
    feedbackUsed: false,
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
    // The sentence names the action; no separate heading repeats it.
    expect(within(section).queryByText('aiInsights.action.kind.stop_transaction')).toBeNull();
    expect(section.getAttribute('aria-label')).toBe('aiInsights.action.kind.stop_transaction');
    // One status for the insight and its action: the section shows no badge of its own.
    expect(screen.queryByTestId('ai-insight-action-status')).toBeNull();
    expect(screen.getByTestId('ai-insight-action-rationale').textContent).toBe(
      'aiWorkers.rationale.stuckSessionIdle(95)',
    );
    expect(within(section).getByText('aiInsights.action.measured.minutes(95)')).toBeTruthy();
    expect(within(section).getByText('2026-10-10T08:00:00Z')).toBeTruthy();
    // The precondition is checked on confirm, not shown as a row.
    expect(within(section).queryByText('aiInsights.action.precondition.session_active')).toBeNull();
  });

  it('shows the OCPP transaction id once, leaves the record rows to the Details panel, and no raw arguments', () => {
    wrap(<InsightActionSection insight={insight()} />);
    const section = screen.getByTestId('ai-insight-action');
    expect(within(section).getAllByText('aiInsights.action.measured.transactionId')).toHaveLength(
      1,
    );
    expect(within(section).queryByText('stationId')).toBeNull();
    expect(within(section).queryByText('transactionId')).toBeNull();
    expect(screen.queryByTestId('ai-insight-action-arguments')).toBeNull();
    const row = screen.getByTestId('ai-insight-action-transaction');
    expect(row.textContent).toBe('tx-9');
    // Station, site and session are in the insight page's Details panel, not repeated here;
    // the insight page has no copy controls and no View Session link.
    expect(within(section).queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('copy-button')).toBeNull();
  });

  it('keeps the API request in a closed section that shows the method, path and arguments', () => {
    wrap(<InsightActionSection insight={insight()} />);
    const api = screen.getByTestId('ai-insight-action-api');
    expect(api.textContent).toContain('aiInsights.action.apiRequest');
    expect(api.textContent).toContain('/v1/ocpp/commands/');
    // The method is a colored badge, the same colors as the access logs.
    expect(within(api).getByTestId('ai-insight-action-method').className).toContain('bg-success');
    // A long path wraps inside the card on a phone instead of widening it.
    expect(within(api).getByText(/\/v1\/ocpp\/commands\//).className).toContain('wrap-anywhere');
    expect(within(api).queryByText(/"transactionId"/)).toBeNull();
    fireEvent.click(within(api).getByRole('button'));
    expect(within(api).getByText(/"transactionId": "tx-9"/)).toBeTruthy();
  });

  it('an OCPP 1.6 stop shows the integer transaction id from the arguments', () => {
    wrap(
      <InsightActionSection
        insight={insight({
          action: action({
            operationId: 'ocppv16_RemoteStopTransaction',
            path: '/v1/ocpp/commands/v16/RemoteStopTransaction',
            args: { stationId: 'CS-1', transactionId: 2 },
            summary: { action: 'stop_transaction', transactionId: 2 },
            sessionId: null,
          }),
        })}
      />,
    );
    const row = screen.getByTestId('ai-insight-action-transaction');
    expect(row.textContent).toBe('2');
    expect(screen.queryByTestId('ai-insight-action-session')).toBeNull();
  });

  it('names the station and transaction of an EVSE stop and says how the stop bills', () => {
    const stop = (code: string) =>
      action({
        operationId: 'stopActiveEvseSession',
        path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
        args: { id: 'st-db-1', evseId: 1 },
        summary: {
          action: 'stop_transaction',
          stationId: 'CS-1',
          transactionId: 'tx-9',
          rationale: { code: 'stuckSessionIdle', params: { minutes: 95 } },
          billing: { code, params: { energyWh: 14_800, costCents: null, currency: 'EUR' } },
        },
      });
    wrap(<InsightActionSection insight={insight({ action: stop('stuckSessionStopOngoing') })} />);
    expect(screen.getByTestId('ai-insight-action-summary').textContent).toBe(
      'ai.confirmAction.stop(CS-1,tx-9)',
    );
    expect(screen.getByTestId('ai-insight-action').getAttribute('aria-label')).toBe(
      'aiInsights.action.kind.stop_transaction',
    );
    expect(screen.getByTestId('ai-insight-action-billing').textContent).toBe(
      'aiWorkers.billing.stuckSessionStopOngoing',
    );
    cleanup();
    wrap(
      <InsightActionSection insight={insight({ action: stop('stuckSessionStopNotOngoing') })} />,
    );
    expect(screen.getByTestId('ai-insight-action-billing').textContent).toMatch(
      /^aiWorkers\.billing\.stuckSessionStopNotOngoing\(14[.,]8 kWh\)$/,
    );
    cleanup();
    wrap(<InsightActionSection insight={insight({ action: stop('stuckSessionStop') })} />);
    expect(screen.getByTestId('ai-insight-action-billing').textContent).toBe(
      'aiWorkers.billing.stuckSessionStop',
    );
  });

  it('names the CSMS end of an offline station and says it bills the last metered energy once', () => {
    const end = (costCents: number | null) =>
      action({
        operationId: 'endSession',
        path: '/v1/sessions/{id}/end',
        args: { id: 'se1' },
        summary: {
          action: 'end_session',
          stationId: 'CS-1',
          transactionId: 'tx-9',
          rationale: { code: 'stuckSessionOffline', params: { minutes: 120 } },
          billing: {
            code: 'stuckSessionEnd',
            params: { energyWh: 14_800, costCents, currency: 'EUR' },
          },
        },
      });
    wrap(<InsightActionSection insight={insight({ action: end(518) })} />);
    expect(screen.getByTestId('ai-insight-action-summary').textContent).toBe(
      'ai.confirmAction.endSession(CS-1,tx-9)',
    );
    expect(screen.getByTestId('ai-insight-action').getAttribute('aria-label')).toBe(
      'aiInsights.action.kind.end_session',
    );
    const withCost = screen.getByTestId('ai-insight-action-billing').textContent;
    expect(withCost).toMatch(/^aiWorkers\.billing\.stuckSessionEndWithCost\(14[.,]8 kWh,/);
    expect(withCost).toContain('5');
    cleanup();
    wrap(<InsightActionSection insight={insight({ action: end(null) })} />);
    expect(screen.getByTestId('ai-insight-action-billing').textContent).toMatch(
      /^aiWorkers\.billing\.stuckSessionEnd\(14[.,]8 kWh\)$/,
    );
  });

  it('shows no billing row for an action without a known billing code', () => {
    wrap(
      <InsightActionSection
        insight={insight({
          action: action({
            summary: { action: 'stop_transaction', billing: { code: 'other', params: {} } },
          }),
        })}
      />,
    );
    expect(screen.queryByTestId('ai-insight-action-billing')).toBeNull();
  });

  it('a station action has no transaction row', () => {
    wrap(
      <InsightActionSection
        insight={insight({
          kind: 'station_long_faulted',
          sessionId: null,
          action: action({
            operationId: 'ocppv21_Reset',
            path: '/v1/ocpp/commands/v21/Reset',
            args: { stationId: 'CS-1', type: 'OnIdle' },
            summary: { action: 'soft_reset', faultedSince: '2026-10-10T06:00:00Z' },
            sessionId: null,
            precondition: { kind: 'station_faulted', params: {} },
          }),
        })}
      />,
    );
    expect(screen.queryByTestId('ai-insight-action-transaction')).toBeNull();
    expect(screen.queryByText('OnIdle')).toBeNull();
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
      insight({ status: 'done', action: action({ result: { httpStatus: 200 } }) }),
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
    apiMock.post.mockResolvedValue(insight({ status: 'rejected', action: action() }));
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

  it('hides Confirm and Reject without aiInsights:write, and disables them after a decision or once expired', () => {
    perms.delete('aiInsights:write');
    wrap(<InsightActionSection insight={insight()} />);
    expect(screen.queryByTestId('ai-action-confirm')).toBeNull();
    cleanup();
    perms.add('aiInsights:write');
    wrap(
      <InsightActionSection
        insight={insight({ status: 'done', action: action({ result: { httpStatus: 200 } }) })}
      />,
    );
    expect(screen.getByTestId('ai-action-confirm')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('ai-action-reject')).toHaveProperty('disabled', true);
    expect(screen.getByText('aiInsights.action.executed (HTTP 200)')).toBeTruthy();
    cleanup();
    wrap(
      <InsightActionSection
        insight={insight({ action: action({ expiresAt: '2020-01-01T00:00:00Z' }) })}
      />,
    );
    expect(screen.getByTestId('ai-action-confirm')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('ai-action-reject')).toHaveProperty('disabled', true);
  });

  it('localizes a refusal reason and shows no stored text', () => {
    wrap(
      <InsightActionSection
        insight={insight({
          status: 'open',
          action: action({
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

  it('leads a stuck session at an offline station with getting it back online, without an action', async () => {
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    wrap(
      <InsightCard
        insight={insight({
          status: 'open',
          action: null,
          category: 'connectivity',
          fixes: [
            { code: 'check_power_supply' },
            { code: 'check_network_connection' },
            { code: 'contact_site' },
          ],
          scope: { stationOffline: { since } },
        })}
      />,
    );
    const advice = await screen.findByTestId('ai-insight-station-offline');
    // Station, how long, since when (the key-echo t mock lists the values).
    expect(advice.textContent).toMatch(/^aiInsights\.stationOffline\.advice\(CS-1,3h/);
    const link = within(advice).getByTestId('ai-insight-connection-history');
    expect(link.getAttribute('href')).toBe('/stations/st-db-1?tab=security');
    expect(screen.getByTestId('ai-insight-fixes').textContent).toContain(
      'aiInsights.fix.contact_site',
    );
    expect(screen.queryByTestId('ai-insight-action')).toBeNull();
  });

  it.each([
    ['wait', ['wait_for_concurrent_session', 'check_shared_token']],
    ['end', ['end_concurrent_session']],
  ] as const)(
    'explains the session a refused card already runs (%s) and links it',
    async (step, fixes) => {
      wrap(
        <InsightCard
          insight={insight({
            kind: 'authorization_refused',
            status: 'open',
            action: null,
            sessionId: null,
            category: 'token',
            fixes: fixes.map((code) => ({ code })),
            scope: {
              concurrentSession: {
                sessionId: 'ses_live',
                stationId: 'st-db-2',
                station: 'CS-1853',
                startedAt: '2026-10-15T12:00:00Z',
                step,
              },
            },
          })}
        />,
      );
      const block = await screen.findByTestId('ai-insight-concurrent-session');
      expect(block.textContent).toMatch(
        new RegExp(`^aiInsights\\.concurrentSession\\.${step}\\(CS-1853,`),
      );
      expect(
        within(block).getByTestId('ai-insight-concurrent-session-link').getAttribute('href'),
      ).toBe('/sessions/ses_live');
      const listed = screen.getByTestId('ai-insight-fixes').textContent;
      for (const code of fixes) expect(listed).toContain(`aiInsights.fix.${code}`);
      if (step === 'wait') expect(listed).not.toContain('end_concurrent_session');
    },
  );

  it('shows no offline advice for an insight without the station offline scope', async () => {
    wrap(<InsightCard insight={insight()} />);
    await screen.findByTestId('ai-insight-action');
    expect(screen.queryByTestId('ai-insight-station-offline')).toBeNull();
  });

  it('lists other steps above the action, never under its buttons, and skips the step the action does', async () => {
    wrap(
      <InsightCard
        insight={insight({
          kind: 'station_long_faulted',
          sessionId: null,
          fixes: [{ code: 'reboot_station' }, { code: 'inspect_connector' }],
          action: action({
            operationId: 'ocppv21_Reset',
            path: '/v1/ocpp/commands/v21/Reset',
            args: { stationId: 'CS-1', type: 'OnIdle' },
            summary: { action: 'soft_reset', faultedSince: '2026-10-10T06:00:00Z' },
            sessionId: null,
            precondition: { kind: 'station_faulted', params: {} },
          }),
        })}
      />,
    );
    const steps = await screen.findByTestId('ai-insight-fixes');
    // The reset is the reboot, so only the other step is listed.
    expect(within(steps).queryByText('aiInsights.fix.reboot_station')).toBeNull();
    expect(within(steps).getByText('aiInsights.fix.inspect_connector')).toBeTruthy();
    // The steps come before the action, so the buttons end the section at every width.
    const buttons = screen.getByTestId('ai-action-buttons');
    expect(steps.compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the confirm-by time on the Suggested Fix heading row, not under the sentence', async () => {
    wrap(<InsightCard insight={insight()} />);
    const fix = await screen.findByTestId('ai-insight-fix');
    const expiry = within(fix).getByTestId('ai-insight-action-expiry');
    expect(expiry.parentElement?.textContent).toContain('aiInsights.fixesLabel');
    // A tooltip explains why the action has a deadline.
    expect(expiry.querySelector('button, [role="button"], svg')).not.toBeNull();
    expect(within(screen.getByTestId('ai-insight-action')).queryByText(/expiresAt/)).toBeNull();
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
    // One History list covers the insight and its action.
    expect(await screen.findAllByText('audit.history')).toHaveLength(1);
  });

  it('reads only known summary values and maps operation ids to tool names', () => {
    expect(
      readActionSummary({ action: 'drop_tables', rationale: { code: '<script>' } }),
    ).toMatchObject({ action: null, rationale: null });
    expect(actionToolName('ocppv21_RequestStopTransaction')).toBe(
      'ocppv21_request_stop_transaction',
    );
    expect(actionTransactionId({ args: { transactionId: 7 }, summary: {} })).toBe('7');
    expect(
      actionTransactionId({ args: { stationId: 'CS-1' }, summary: { transactionId: 'tx-1' } }),
    ).toBe('tx-1');
    expect(actionTransactionId({ args: { stationId: 'CS-1' }, summary: {} })).toBeNull();
    expect(isActionOpen('pending', { expiresAt: FUTURE })).toBe(true);
    expect(isActionOpen('rejected', { expiresAt: FUTURE })).toBe(false);
    expect(isActionOpen('pending', { expiresAt: '2020-01-01T00:00:00Z' })).toBe(false);
  });
});
