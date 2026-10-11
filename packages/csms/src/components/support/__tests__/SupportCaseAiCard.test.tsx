// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() }, postStream: vi.fn() };
});

import { SupportCaseAiBadge, SupportCaseAiCard, driverAiStateVariant } from '../SupportCaseAiCard';
import { MessageThread } from '../MessageThread';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  getMock.mockResolvedValue({ enabled: false, supportAssistEnabled: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('operator view of the driver AI step (TC-AI-DR-UI-04)', () => {
  it('TC-AI-DR-UI-04: shows the consent row with decision, time, language and notice version', () => {
    render(
      <SupportCaseAiCard
        timezone="UTC"
        fields={{
          aiConsent: {
            decision: 'granted',
            at: '2026-10-11T10:00:00Z',
            language: 'de',
            noticeVersion: 1,
          },
          aiState: 'escalated',
          aiStateReason: 'driver_declined_answer',
          aiAnsweredAt: '2026-10-11T10:01:00Z',
          aiFeedbackAt: '2026-10-11T10:02:00Z',
          resolutionSource: null,
        }}
      />,
    );
    const card = screen.getByTestId('support-case-ai-card');
    expect(within(card).getByText('supportCases.ai.consentTitle')).toBeTruthy();
    expect(within(card).getByText('supportCases.ai.consent.granted')).toBeTruthy();
    expect(within(card).getByText('de')).toBeTruthy();
    expect(within(card).getByText('1')).toBeTruthy();
    expect(within(card).getByText('supportCases.ai.state.escalated')).toBeTruthy();
    expect(within(card).getByText('supportCases.ai.reason.driver_declined_answer')).toBeTruthy();
    expect(within(card).getByText('supportCases.ai.answeredAt')).toBeTruthy();
    expect(within(card).getByText('supportCases.ai.feedbackAt')).toBeTruthy();
  });

  it('shows a declined consent without an AI state', () => {
    render(
      <SupportCaseAiCard
        timezone="UTC"
        fields={{
          aiConsent: {
            decision: 'declined',
            at: '2026-10-11T10:00:00Z',
            language: 'en',
            noticeVersion: 1,
          },
          aiState: null,
        }}
      />,
    );
    expect(screen.getByText('supportCases.ai.consent.declined')).toBeTruthy();
    expect(screen.queryByText('supportCases.ai.stateLabel')).toBeNull();
  });

  it('is hidden when the driver was not asked and the case had no AI step', () => {
    render(<SupportCaseAiCard timezone="UTC" fields={{ aiConsent: null, aiState: null }} />);
    expect(screen.queryByTestId('support-case-ai-card')).toBeNull();
  });

  it('TC-AI-DR-UI-04: badges "Resolved by AI" over the AI state, nothing without an AI step', () => {
    render(<SupportCaseAiBadge aiState="resolved_by_ai" resolutionSource="ai" />);
    expect(screen.getByText('supportCases.ai.resolvedByAi')).toBeTruthy();
    cleanup();
    render(<SupportCaseAiBadge aiState="awaiting_feedback" resolutionSource={null} />);
    expect(screen.getByText('supportCases.ai.state.awaiting_feedback')).toBeTruthy();
    cleanup();
    const { container } = render(<SupportCaseAiBadge aiState={null} resolutionSource={null} />);
    expect(container.textContent).toBe('');
  });

  it('maps every AI state to a badge variant', () => {
    expect(driverAiStateVariant('queued')).toBe('info');
    expect(driverAiStateVariant('analyzing')).toBe('info');
    expect(driverAiStateVariant('awaiting_feedback')).toBe('info');
    expect(driverAiStateVariant('resolved_by_ai')).toBe('success');
    expect(driverAiStateVariant('escalated')).toBe('secondary');
    expect(driverAiStateVariant('failed')).toBe('warning');
    expect(driverAiStateVariant('skipped')).toBe('outline');
  });

  it('TC-AI-DR-UI-04: styles the assistant message in the thread as the automatic answer', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MessageThread
          caseId="case-1"
          timezone="UTC"
          s3Configured={false}
          supportAiEnabled={false}
          onMessageSent={vi.fn()}
          messages={[
            {
              id: 1,
              senderType: 'driver',
              senderId: 'drv-1',
              body: 'It stopped',
              isInternal: false,
              createdAt: '2026-10-11T10:00:00Z',
              attachments: [],
            },
            {
              id: 2,
              senderType: 'assistant',
              senderId: null,
              body: 'Try another connector.',
              isInternal: false,
              createdAt: '2026-10-11T10:01:00Z',
              attachments: [],
            },
          ]}
        />
      </QueryClientProvider>,
    );
    const answer = screen.getByText('Try another connector.').closest('[data-sender]');
    expect(answer?.getAttribute('data-sender')).toBe('assistant');
    expect(within(answer as HTMLElement).getByText('supportCases.ai.automaticAnswer')).toBeTruthy();
    expect(within(answer as HTMLElement).queryByText('supportCases.operatorMessage')).toBeNull();
  });
});
