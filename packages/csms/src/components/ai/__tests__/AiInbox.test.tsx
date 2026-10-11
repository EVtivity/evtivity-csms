// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AiProposalView } from '../inbox/proposal-api';

const { apiMock, perms, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn() },
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
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
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
import { AiInbox } from '@/pages/AiInbox';
import { AiInboxDetail } from '@/pages/AiInboxDetail';
import { ProposalCard } from '../inbox/ProposalCard';
import { RecordProposals } from '../inbox/RecordProposals';
import { proposalToolName } from '../inbox/proposal-api';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { Inbox } from 'lucide-react';

const FUTURE = '2099-01-01T00:00:00Z';

function proposal(overrides: Partial<AiProposalView> = {}): AiProposalView {
  return {
    id: 'p1',
    source: 'worker',
    job: 'stuck_sessions',
    insightId: null,
    requestedByUserId: null,
    apiKeyName: null,
    siteId: 'site1',
    stationId: 'st-db-1',
    sessionId: 'se1',
    operationId: 'ocppv21_RequestStopTransaction',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/RequestStopTransaction',
    args: { stationId: 'CS-1', transactionId: 'tx-9' },
    argsHash: 'hash-1',
    summary: {},
    rationaleText: 'No meter values for 95 minutes',
    rationaleLanguage: 'en',
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
  perms.add('aiProposals:read');
  perms.add('aiProposals:write');
  apiMock.get.mockResolvedValue({ data: [proposal()], total: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AI Inbox (TC-AI-WK-UI-*)', () => {
  it('TC-AI-WK-UI-01: lists pending proposals in the standard table and filters by source, job and status', async () => {
    wrap(<AiInbox />);
    expect(await screen.findByTestId('ai-inbox-row')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/proposals?page=1&limit=20&status=pending');
    fireEvent.change(screen.getByLabelText('aiInbox.filters.source'), {
      target: { value: 'mcp' },
    });
    fireEvent.change(screen.getByLabelText('aiInbox.filters.job'), {
      target: { value: 'tariff_anomalies' },
    });
    fireEvent.change(screen.getByLabelText('aiInbox.filters.status'), { target: { value: '' } });
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenLastCalledWith(
        '/v1/ai/proposals?page=1&limit=20&source=mcp&job=tariff_anomalies',
      );
    });
  });

  it('TC-AI-WK-UI-01: a row shows status, action, station, site, source, created and expiry and opens the proposal', async () => {
    apiMock.get.mockResolvedValue({
      data: [proposal({ stationName: 'CS-1', siteName: 'Convention Center' })],
      total: 1,
    });
    wrap(
      <Routes>
        <Route path="/ai/inbox" element={<AiInbox />} />
        <Route path="/ai/inbox/:id" element={<p>detail page</p>} />
      </Routes>,
      '/ai/inbox',
    );
    const row = await screen.findByTestId('ai-inbox-row');
    expect(within(row).getByText('aiInbox.status.pending')).toBeTruthy();
    expect(within(row).getByText('aiInbox.action.stop_transaction')).toBeTruthy();
    expect(within(row).getByText('CS-1')).toBeTruthy();
    expect(within(row).getByText('Convention Center')).toBeTruthy();
    expect(within(row).getByText('aiInbox.job.stuck_sessions')).toBeTruthy();
    expect(within(row).getByText(FUTURE)).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText('detail page')).toBeTruthy();
  });

  it('names an MCP row by its client', async () => {
    apiMock.get.mockResolvedValue({
      data: [proposal({ source: 'mcp', job: null, summary: { clientName: 'Desk agent' } })],
      total: 1,
    });
    wrap(<AiInbox />);
    const row = await screen.findByTestId('ai-inbox-row');
    expect(within(row).getByText('Desk agent')).toBeTruthy();
    expect(within(row).getByText('aiInbox.source.mcp')).toBeTruthy();
  });

  it('shows the empty state in the table', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    wrap(<AiInbox />);
    expect(await screen.findByText('aiInbox.empty')).toBeTruthy();
  });

  it('TC-AI-WK-UI-02: the inline card leads with the localized sentence, the action and the rationale', () => {
    wrap(
      <ProposalCard
        proposal={proposal({
          summary: { rationale: { code: 'stuckSessionIdle', params: { minutes: 95 } } },
        })}
      />,
    );
    expect(screen.getByTestId('ai-proposal-summary').textContent).toBe(
      'ai.confirmAction.stop(CS-1,tx-9)',
    );
    expect(screen.getByText('aiInbox.action.stop_transaction')).toBeTruthy();
    expect(screen.getByText('aiInbox.job.stuck_sessions')).toBeTruthy();
    expect(screen.getByTestId('ai-proposal-rationale').textContent).toBe(
      'aiWorkers.rationale.stuckSessionIdle(95)',
    );
    expect(screen.getByTestId('ai-proposal-details').getAttribute('href')).toBe('/ai/inbox/p1');
  });

  it('an unknown summary falls back to the operation', () => {
    wrap(
      <ProposalCard
        proposal={proposal({
          operationId: 'ocppv21_Reset',
          summary: { action: 'drop_tables', rationale: { code: '<script>' } },
        })}
      />,
    );
    expect(screen.getByText('aiInbox.action.soft_reset')).toBeTruthy();
    expect(screen.queryByTestId('ai-proposal-rationale')).toBeNull();
  });

  it('TC-AI-WK-UI-02: Confirm asks in the standard dialog, then sends the argsHash shown and raises a toast', async () => {
    apiMock.post.mockResolvedValue(proposal({ status: 'executed', result: { httpStatus: 200 } }));
    wrap(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('ai-proposal-confirm'));
    expect(apiMock.post).not.toHaveBeenCalled();
    await confirmInDialog('aiInbox.confirm');
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/proposals/p1/confirm', {
        argsHash: 'hash-1',
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'aiInbox.executed' });
    });
  });

  it('Reject asks in the standard dialog, then posts to the reject endpoint', async () => {
    apiMock.post.mockResolvedValue(proposal({ status: 'rejected' }));
    wrap(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('ai-proposal-reject'));
    await confirmInDialog('aiInbox.reject');
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/ai/proposals/p1/reject', {});
    });
  });

  it('a stale proposal shows its refusal inline on the card, not in a toast', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(409, { error: 'stale', code: 'AI_PROPOSAL_STALE' }),
    );
    wrap(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('ai-proposal-confirm'));
    await confirmInDialog('aiInbox.confirm');
    const alert = await screen.findByTestId('ai-proposal-error');
    expect(alert.closest('[data-testid="ai-proposal-card"]')).toBeTruthy();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('hides Confirm and Reject without aiProposals:write, after a decision, and once expired', () => {
    perms.delete('aiProposals:write');
    wrap(<ProposalCard proposal={proposal()} />);
    expect(screen.queryByTestId('ai-proposal-confirm')).toBeNull();
    cleanup();
    perms.add('aiProposals:write');
    wrap(<ProposalCard proposal={proposal({ status: 'executed', result: { httpStatus: 200 } })} />);
    expect(screen.queryByTestId('ai-proposal-confirm')).toBeNull();
    cleanup();
    wrap(<ProposalCard proposal={proposal({ expiresAt: '2020-01-01T00:00:00Z' })} />);
    expect(screen.queryByTestId('ai-proposal-confirm')).toBeNull();
  });

  it('TC-AI-WK-UI-03: the MCP approval page shows the requester, key and client, untrusted, the full arguments and the actions in the header', async () => {
    perms.add('audit:read');
    const mcp = proposal({
      id: 'mcp1',
      source: 'mcp',
      job: null,
      requestedByUserId: 'u1',
      requestedByName: 'Dana Operator',
      apiKeyName: 'Ops laptop key',
      clientName: 'Some <b>Client</b>',
      clientVersion: '1.2',
      operationId: 'ocppv21_Reset',
      path: '/v1/ocpp/commands/v21/Reset',
      args: { stationId: 'CS-1', type: 'OnIdle', nested: { evseId: 2 } },
      precondition: null,
      rationaleText: null,
      summary: { requestedTool: 'ocppv16_reset' },
    });
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/v1/audit') ? { data: [], total: 0 } : mcp),
    );
    wrap(
      <Routes>
        <Route path="/ai/inbox/:id" element={<AiInboxDetail />} />
      </Routes>,
      '/ai/inbox/mcp1',
    );
    expect((await screen.findByTestId('ai-proposal-title')).textContent).toBe(
      'aiInbox.action.soft_reset',
    );
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/proposals/mcp1');
    expect(screen.getByText('Dana Operator')).toBeTruthy();
    expect(screen.getByTestId('ai-proposal-api-key').textContent).toBe('Ops laptop key');
    // Shown as text, never as markup.
    expect(screen.getByTestId('ai-proposal-client').textContent).toBe('Some <b>Client</b> 1.2');
    expect(screen.getByText('ocppv16_reset')).toBeTruthy();
    expect(screen.getByText('aiInbox.untrustedNote')).toBeTruthy();
    expect(screen.getByTestId('ai-proposal-arguments').textContent).toContain('"evseId": 2');
    expect(screen.getByTestId('ai-proposal-confirm')).toBeTruthy();
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/audit/ai_proposal/mcp1?page=1&limit=20');
    });
  });

  it('the detail page shows the rationale with the measured values and links the target', async () => {
    apiMock.get.mockResolvedValue(
      proposal({
        stationName: 'CS-1',
        siteName: 'Convention Center',
        rationaleText: null,
        summary: {
          action: 'stop_transaction',
          transactionId: 'tx-9',
          lastActivityAt: '2026-10-10T08:00:00Z',
          rationale: { code: 'stuckSessionIdle', params: { minutes: 95 } },
        },
      }),
    );
    wrap(
      <Routes>
        <Route path="/ai/inbox/:id" element={<AiInboxDetail />} />
      </Routes>,
      '/ai/inbox/p1',
    );
    const rationale = await screen.findByTestId('ai-proposal-rationale-card');
    expect(within(rationale).getByText('aiWorkers.rationale.stuckSessionIdle(95)')).toBeTruthy();
    expect(within(rationale).getByText('aiInbox.measured.minutes(95)')).toBeTruthy();
    expect(within(rationale).getByText('2026-10-10T08:00:00Z')).toBeTruthy();
    expect(within(rationale).getByText('tx-9')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'CS-1' }).getAttribute('href')).toBe(
      '/stations/st-db-1',
    );
    expect(screen.getByText('Convention Center').closest('a')?.getAttribute('href')).toBe(
      '/sites/site1',
    );
    expect(screen.getByText('se1').closest('a')?.getAttribute('href')).toBe('/sessions/se1');
  });

  it('the approval page shows not found for a proposal the user cannot see', async () => {
    apiMock.get.mockRejectedValue(
      new ApiError(404, { error: 'not found', code: 'AI_PROPOSAL_NOT_FOUND' }),
    );
    wrap(
      <Routes>
        <Route path="/ai/inbox/:id" element={<AiInboxDetail />} />
      </Routes>,
      '/ai/inbox/other',
    );
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/proposals/other');
    });
    expect(screen.queryByTestId('ai-proposal-title')).toBeNull();
  });

  it('station and session pages list their pending proposals', async () => {
    wrap(<RecordProposals stationId="st-db-1" />);
    expect(await screen.findByTestId('ai-record-proposals')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith(
      '/v1/ai/proposals?page=1&limit=3&status=pending&stationId=st-db-1',
    );
  });

  it('asks nothing without aiProposals:read', () => {
    perms.clear();
    wrap(<RecordProposals sessionId="se1" />);
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('maps an operation id to the tool name the confirm sentences know', () => {
    expect(proposalToolName('ocppv21_RequestStopTransaction')).toBe(
      'ocppv21_request_stop_transaction',
    );
    expect(proposalToolName('ocppv16_ChangeAvailability')).toBe('ocppv16_change_availability');
  });
});

describe('AI Inbox nav badge (TC-AI-WK-UI-01)', () => {
  it('shows the pending count on the Inbox entry', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 4 });
    wrap(
      <SidebarNav
        items={[{ to: '/ai/inbox', labelKey: 'nav.aiInbox', icon: Inbox }]}
        collapsed={false}
      />,
    );
    expect((await screen.findByTestId('ai-inbox-badge')).textContent).toBe('4');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/proposals?page=1&limit=1&status=pending');
  });

  it('shows no badge with nothing pending', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    wrap(
      <SidebarNav
        items={[{ to: '/ai/inbox', labelKey: 'nav.aiInbox', icon: Inbox }]}
        collapsed={false}
      />,
    );
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ai-inbox-badge')).toBeNull();
  });
});
