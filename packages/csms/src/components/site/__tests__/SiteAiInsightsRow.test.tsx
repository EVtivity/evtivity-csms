// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', () => ({ formatDateTime: (v: string) => v }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { SiteAiInsightsRow } from '../SiteAiInsightsRow';
import type { SiteAiInsightsState } from '../SiteAiInsightsRow';

function renderRow(site: SiteAiInsightsState): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <dl>
        <SiteAiInsightsRow siteId="sit_1" site={site} timezone="UTC" />
      </dl>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
  apiMock.post.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SiteAiInsightsRow', () => {
  it('shows In Scope and no buttons without sites:write', () => {
    renderRow({ aiInsightsSuppressed: false, aiInsightsSuppressedAt: null });
    expect(screen.getByTestId('site-ai-insights-badge').textContent).toBe(
      'sites.aiInsights.inScope',
    );
    expect(screen.queryByRole('button', { name: 'sites.aiInsights.suppress' })).toBeNull();
  });

  it('suppresses the site through the shared dialog with a required reason', async () => {
    perms.add('sites:write');
    apiMock.post.mockResolvedValue({});
    renderRow({ aiInsightsSuppressed: false, aiInsightsSuppressedAt: null });
    fireEvent.click(screen.getByRole('button', { name: 'sites.aiInsights.suppress' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('sites.aiInsights.suppressTitle')).toBeDefined();
    const confirm = within(dialog).getByRole('button', { name: 'sites.aiInsights.suppress' });
    fireEvent.click(confirm);
    expect(within(dialog).getByText('stations.aiInsights.reasonRequired')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('stations.aiInsights.reason'), {
      target: { value: 'Rebuild' },
    });
    fireEvent.change(within(dialog).getByLabelText('stations.aiInsights.endDate'), {
      target: { value: '2030-01-02T03:04' },
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sites/sit_1/ai-insights/suppress', {
        reason: 'Rebuild',
        until: new Date('2030-01-02T03:04').toISOString(),
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'sites.aiInsights.suppressedToast',
      });
    });
  });

  it('shows who suppressed, until when and why, and resumes', async () => {
    perms.add('sites:write');
    apiMock.post.mockResolvedValue({});
    renderRow({
      aiInsightsSuppressed: true,
      aiInsightsSuppressedSources: ['site'],
      aiInsightsSuppressedAt: '2026-10-15T10:00:00Z',
      aiInsightsSuppressedUntil: '2026-10-20T10:00:00Z',
      aiInsightsSuppressedByName: 'Ada Lovelace',
      aiInsightsSuppressedReason: 'Rebuild',
    });
    expect(screen.getByTestId('site-ai-insights-detail').textContent).toBe(
      'sites.aiInsights.until(2026-10-20T10:00:00Z) · sites.aiInsights.by(Ada Lovelace,Rebuild)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'sites.aiInsights.resume' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sites.aiInsights.resume' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sites/sit_1/ai-insights/resume', {});
    });
  });

  it('shows a whole-site maintenance suppression with Suppress still offered', () => {
    perms.add('sites:write');
    renderRow({
      aiInsightsSuppressed: true,
      aiInsightsSuppressedSources: ['maintenance'],
      aiInsightsSuppressedAt: null,
    });
    expect(screen.getByText('sites.aiInsights.maintenance')).toBeDefined();
    expect(screen.getByRole('button', { name: 'sites.aiInsights.suppress' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'sites.aiInsights.resume' })).toBeNull();
  });
});
