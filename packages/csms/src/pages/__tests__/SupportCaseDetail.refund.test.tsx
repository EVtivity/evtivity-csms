// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The support case refund needs support:write and payments:write, as its
// route does: the Refund button is hidden without either.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { perms, getMock } = vi.hoisted(() => ({
  perms: new Set<string>(),
  getMock: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn().mockResolvedValue({}), patch: vi.fn() } };
});
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/support/MessageThread', () => ({ MessageThread: () => null }));
vi.mock('@/components/support/CaseInfoSidebar', () => ({ CaseInfoSidebar: () => null }));
vi.mock('@/components/support/SupportCaseAiCard', () => ({
  SupportCaseAiBadge: () => null,
  SupportCaseAiCard: () => null,
}));
vi.mock('@/components/ai/insights/SupportCaseInsights', () => ({
  SupportCaseInsights: () => null,
}));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));

import { SupportCaseDetail } from '../SupportCaseDetail';

const CASE = {
  id: 'case_1',
  caseNumber: 'CASE-1',
  subject: 'Overcharged',
  description: 'Charged twice',
  status: 'open',
  category: 'billing_dispute',
  priority: 'medium',
  driverId: null,
  driverName: null,
  stationId: null,
  stationName: null,
  assignedTo: null,
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  resolvedAt: null,
  messages: [],
  sessions: [
    {
      id: 'ses_1',
      transactionId: 'TX-1',
      stationName: 'CS-1',
      driverName: null,
      status: 'completed',
    },
  ],
};

const PAYMENT = {
  id: 1,
  sessionId: 'ses_1',
  status: 'captured',
  capturedAmountCents: 1000,
  refundedAmountCents: 0,
  currency: 'USD',
};

beforeEach(() => {
  perms.clear();
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/support-cases/case_1') return Promise.resolve(CASE);
    if (url === '/v1/sessions/ses_1/payment') return Promise.resolve(PAYMENT);
    if (url.startsWith('/v1/users')) return Promise.resolve({ data: [] });
    if (url === '/v1/security/public') return Promise.resolve({ supportAiEnabled: false });
    return Promise.resolve({ configured: false, data: [] });
  });
});

afterEach(() => {
  cleanup();
});

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/support-cases/case_1']}>
        <Routes>
          <Route path="/support-cases/:id" element={<SupportCaseDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SupportCaseDetail refund', () => {
  it('offers a refund with support:write and payments:write', async () => {
    perms.add('support:write');
    perms.add('payments:write');
    renderPage();
    expect(await screen.findByText(/supportCases\.refundSession/)).toBeDefined();
  });

  it('hides the refund without payments:write', async () => {
    perms.add('support:write');
    renderPage();
    // The captured amount shows once the payment loaded; the refund would show with it.
    await screen.findByText(/USD/);
    expect(screen.queryByText(/supportCases\.refundSession/)).toBeNull();
  });
});
