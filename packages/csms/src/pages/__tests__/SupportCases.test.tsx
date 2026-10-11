// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DRIVER_AI_STATES } from '@evtivity/lib/driver-ai';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (v: string) => v,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});

import { SupportCases } from '../SupportCases';

const CASE = {
  id: 'case-1',
  caseNumber: 'SC-0001',
  subject: 'Charging stopped',
  status: 'resolved',
  category: 'charging_failure',
  priority: 'medium',
  createdByDriver: true,
  driverName: 'Ann Lee',
  assignedToName: null,
  assignedTo: null,
  driverId: 'drv-1',
  isRead: true,
  createdAt: '2026-10-11T10:00:00Z',
  aiState: 'resolved_by_ai',
  resolutionSource: 'ai',
};

function caseUrls(): string[] {
  return getMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/v1/support-cases?'));
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SupportCases />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith('/v1/support-cases?') ? { data: [CASE], total: 1 } : { data: [], total: 0 },
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('support case list AI filters (TC-AI-DR-UI-08)', () => {
  it('TC-AI-DR-UI-08: filters by AI state and by who resolved the case', async () => {
    renderPage();
    await screen.findByText('SC-0001');
    const aiState = screen.getByLabelText('supportCases.ai.filterAiState');
    const options = within(aiState)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', ...DRIVER_AI_STATES]);
    fireEvent.change(aiState, { target: { value: 'awaiting_feedback' } });
    await waitFor(() => {
      expect(caseUrls().some((u) => u.includes('aiState=awaiting_feedback'))).toBe(true);
    });
    fireEvent.change(screen.getByLabelText('supportCases.ai.filterResolvedBy'), {
      target: { value: 'ai' },
    });
    await waitFor(() => {
      expect(caseUrls().some((u) => u.includes('resolutionSource=ai'))).toBe(true);
    });
  });

  it('offers the cases still with the AI (ai_assist) as a status filter, not in the default list', async () => {
    renderPage();
    await screen.findByText('SC-0001');
    // Default request: no status, so the API leaves ai_assist out (E4).
    expect(caseUrls()[0]).not.toContain('status=');
    const status = screen.getByLabelText('common.status');
    fireEvent.change(status, { target: { value: 'ai_assist' } });
    await waitFor(() => {
      expect(caseUrls().some((u) => u.includes('status=ai_assist'))).toBe(true);
    });
  });

  it('badges a case the AI resolved', async () => {
    renderPage();
    const row = (await screen.findByText('SC-0001')).closest('tr') as HTMLElement;
    expect(within(row).getByText('supportCases.ai.resolvedByAi')).toBeTruthy();
  });
});
