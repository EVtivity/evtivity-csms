// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Headset, Lightbulb } from 'lucide-react';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { SidebarNav } from '@/components/layout/SidebarNav';
import { getQueryKeysForEvent } from '@/hooks/event-query-keys';

const SUPPORT = { to: '/support-cases', labelKey: 'nav.supportCases', icon: Headset } as const;
const INSIGHTS = { to: '/ai/insights', labelKey: 'nav.aiInsights', icon: Lightbulb } as const;

function wrap(ui: React.ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function serveCounts(unassigned: number, pending = 0): void {
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/v1/support-cases/unassigned-count'
        ? { count: unassigned }
        : { data: [], total: pending },
    ),
  );
}

beforeEach(() => {
  perms.clear();
  perms.add('support:read');
  perms.add('aiInsights:read');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Support Cases nav badge', () => {
  it('shows the unassigned case count in the AI Insights badge style', async () => {
    serveCounts(3, 4);
    wrap(<SidebarNav items={[SUPPORT, INSIGHTS]} collapsed={false} />);
    const badge = await screen.findByTestId('support-cases-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('nav.unassignedCasesCount(3)');
    const insights = await screen.findByTestId('ai-insights-badge');
    expect(badge.className).toBe(insights.className);
    expect(apiMock.get).toHaveBeenCalledWith('/v1/support-cases/unassigned-count');
    // The badge no longer counts unread cases assigned to the user.
    expect(apiMock.get).not.toHaveBeenCalledWith('/v1/support-cases/unread-count');
  });

  it('caps the pill at 99+', async () => {
    serveCounts(120);
    wrap(<SidebarNav items={[SUPPORT]} collapsed={false} />);
    expect((await screen.findByTestId('support-cases-badge')).textContent).toBe('99+');
  });

  it('shows a dot on the icon when the sidebar is collapsed', async () => {
    serveCounts(2);
    wrap(<SidebarNav items={[SUPPORT]} collapsed />);
    const dot = await screen.findByTestId('support-cases-badge');
    expect(dot.textContent).toBe('');
    expect(dot.getAttribute('aria-label')).toBe('nav.unassignedCasesCount(2)');
  });

  it('shows no badge with nothing unassigned', async () => {
    serveCounts(0);
    wrap(<SidebarNav items={[SUPPORT]} collapsed={false} />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('support-cases-badge')).toBeNull();
  });

  it('asks nothing and shows no badge without support:read', async () => {
    perms.delete('support:read');
    serveCounts(5);
    wrap(<SidebarNav items={[SUPPORT]} collapsed={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('support-cases-badge')).toBeNull();
  });

  it('shows the pending insight action count on AI Insights', async () => {
    serveCounts(0, 4);
    wrap(<SidebarNav items={[INSIGHTS]} collapsed={false} />);
    const badge = await screen.findByTestId('ai-insights-badge');
    expect(badge.textContent).toBe('4');
    expect(badge.getAttribute('aria-label')).toBe('aiInsights.action.pendingCount(4)');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/insights?status=pending&limit=1');
  });

  it('asks for no pending action count without aiInsights:read', async () => {
    perms.delete('aiInsights:read');
    serveCounts(0, 4);
    wrap(<SidebarNav items={[INSIGHTS]} collapsed={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock.get).not.toHaveBeenCalledWith('/v1/ai/insights?status=pending&limit=1');
    expect(screen.queryByTestId('ai-insights-badge')).toBeNull();
  });

  it('refreshes on a support case SSE event', async () => {
    serveCounts(1);
    const client = wrap(<SidebarNav items={[SUPPORT]} collapsed={false} />);
    expect((await screen.findByTestId('support-cases-badge')).textContent).toBe('1');
    serveCounts(2);
    const keys = getQueryKeysForEvent({
      eventType: 'supportCase.newMessage',
      stationId: null,
      siteId: null,
      sessionId: null,
      caseId: 'case-1',
      runId: null,
    });
    await act(async () => {
      for (const queryKey of keys) await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => {
      expect(screen.getByTestId('support-cases-badge').textContent).toBe('2');
    });
  });
});
