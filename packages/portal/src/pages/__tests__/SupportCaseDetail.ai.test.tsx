// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { DriverAiCaseDetail } from '@evtivity/lib/driver-ai';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: postMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/timezone', () => ({ useDriverTimezone: () => 'UTC' }));

import { ApiError } from '@/lib/api';
import { SupportCaseDetail } from '../SupportCaseDetail';

const NO_AI: DriverAiCaseDetail = {
  consent: 'granted',
  state: null,
  reason: null,
  answeredAt: null,
  feedbackAt: null,
  resolutionSource: null,
  driverActions: [],
  needsOperator: null,
};

function caseWith(ai: Partial<DriverAiCaseDetail> | null, extra: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    caseNumber: 'SC-0001',
    subject: 'Charging stopped',
    description: 'It stopped',
    status: 'ai_assist',
    category: 'charging_failure',
    priority: 'medium',
    sessions: [],
    stationName: null,
    resolvedAt: null,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    messages: [
      {
        id: 1,
        senderType: 'driver',
        body: 'It stopped',
        createdAt: '2026-10-11T10:00:00Z',
        attachments: [],
      },
    ],
    ai: ai == null ? null : { ...NO_AI, ...ai },
    ...extra,
  };
}

const ANSWER = {
  id: 2,
  senderType: 'assistant',
  body: 'The station stopped because the vehicle ended the session.',
  createdAt: '2026-10-11T10:01:00Z',
  attachments: [],
};

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/support/case-1']}>
        <Routes>
          <Route path="/support/:id" element={<SupportCaseDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('portal SupportCaseDetail driver AI', () => {
  it('TC-AI-DR-UI-03: shows "Analyzing" in a polite live region while queued or analyzing', async () => {
    getMock.mockResolvedValue(caseWith({ state: 'analyzing' }));
    renderPage();
    const status = within(await screen.findByTestId('ai-case-status')).getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(within(status).getByText('supportCases.ai.analyzing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'supportCases.ai.feedbackYes' })).toBeNull();
  });

  it('TC-AI-DR-UI-03: shows the automatic answer labeled as automated, its actions, and the question', async () => {
    const detail = caseWith(
      {
        state: 'awaiting_feedback',
        driverActions: ['try_other_connector', 'retry_start'],
        needsOperator: true,
      },
      {},
    );
    detail.messages.push(ANSWER);
    getMock.mockResolvedValue(detail);
    renderPage();
    const answer = await screen.findByTestId('ai-answer');
    expect(within(answer).getByText('supportCases.ai.answerTitle')).toBeTruthy();
    expect(within(answer).getByText(ANSWER.body)).toBeTruthy();
    expect(
      within(answer).getByText('supportCases.ai.driverAction.try_other_connector'),
    ).toBeTruthy();
    expect(within(answer).getByText('supportCases.ai.driverAction.retry_start')).toBeTruthy();
    expect(screen.getByText('supportCases.ai.feedbackQuestion')).toBeTruthy();
    expect(screen.getByText('supportCases.ai.feedbackNoHint')).toBeTruthy();
  });

  it('shows the support team hint only when the answer says a person is needed', async () => {
    const detail = caseWith({ state: 'awaiting_feedback', needsOperator: false });
    detail.messages.push(ANSWER);
    getMock.mockResolvedValue(detail);
    renderPage();
    expect(await screen.findByText('supportCases.ai.feedbackQuestion')).toBeTruthy();
    expect(screen.queryByText('supportCases.ai.feedbackNoHint')).toBeNull();
  });

  it('TC-AI-DR-UI-03: Yes sends satisfied true; TC-AI-DR-UI-04: No sends satisfied false', async () => {
    const detail = caseWith({ state: 'awaiting_feedback' });
    detail.messages.push(ANSWER);
    getMock.mockResolvedValue(detail);
    postMock.mockResolvedValue({ id: 'case-1', status: 'resolved' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.feedbackYes' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/support-cases/case-1/ai-feedback', {
        satisfied: true,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'supportCases.ai.feedbackNo' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/support-cases/case-1/ai-feedback', {
        satisfied: false,
      });
    });
  });

  it('shows a retry text when the feedback fails and reloads the case', async () => {
    const detail = caseWith({ state: 'awaiting_feedback' });
    detail.messages.push(ANSWER);
    getMock.mockResolvedValue(detail);
    postMock.mockRejectedValue(
      new ApiError(409, { code: 'SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK' }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.feedbackYes' }));
    expect(await screen.findByText('supportCases.ai.feedbackFailed')).toBeTruthy();
    // No error code is shown to the driver.
    expect(screen.queryByText(/SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK/)).toBeNull();
    await waitFor(() => {
      expect(getMock.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it.each([
    ['resolved_by_ai', 'supportCases.ai.resolved'],
    ['escalated', 'supportCases.ai.escalated'],
    ['failed', 'supportCases.ai.sentToTeam'],
    ['skipped', 'supportCases.ai.sentToTeam'],
  ] as const)('shows the end state %s clearly', async (state, text) => {
    getMock.mockResolvedValue(
      caseWith(
        { state, resolutionSource: state === 'resolved_by_ai' ? 'ai' : null },
        { status: state === 'resolved_by_ai' ? 'resolved' : 'open' },
      ),
    );
    renderPage();
    const status = within(await screen.findByTestId('ai-case-status')).getByRole('status');
    expect(within(status).getByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'supportCases.ai.feedbackYes' })).toBeNull();
  });

  it('keeps the composer on a case the automatic answer resolved, hides it on other resolved cases', async () => {
    getMock.mockResolvedValue(
      caseWith({ state: 'resolved_by_ai', resolutionSource: 'ai' }, { status: 'resolved' }),
    );
    renderPage();
    expect(await screen.findByPlaceholderText('supportCases.messagePlaceholder')).toBeTruthy();
    cleanup();
    getMock.mockResolvedValue(caseWith(null, { status: 'resolved' }));
    renderPage();
    await screen.findByText('Charging stopped');
    expect(screen.queryByPlaceholderText('supportCases.messagePlaceholder')).toBeNull();
  });

  it('shows no AI block for a declined or not-asked case', async () => {
    getMock.mockResolvedValue(caseWith({ consent: 'declined' }, { status: 'open' }));
    renderPage();
    await screen.findByText('Charging stopped');
    expect(screen.queryByTestId('ai-case-status')).toBeNull();
  });
});
