// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

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

import { StationAiInsightsRow } from '../StationAiInsightsRow';
import type { StationAiInsightsState } from '../StationAiInsightsRow';

function renderRow(station: StationAiInsightsState): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <dl>
          <StationAiInsightsRow stationId="sta_1" station={station} timezone="UTC" />
        </dl>
      </MemoryRouter>
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

describe('StationAiInsightsRow', () => {
  it('shows In Scope and no buttons without stations:write', () => {
    renderRow({ aiInsightsSuppressed: false, aiInsightsSuppressedAt: null });
    expect(screen.getByTestId('station-ai-insights-badge').textContent).toBe(
      'stations.aiInsights.inScope',
    );
    expect(screen.queryByRole('button', { name: 'stations.aiInsights.suppress' })).toBeNull();
  });

  it('suppresses with a required reason and an optional end date', async () => {
    perms.add('stations:write');
    apiMock.post.mockResolvedValue({});
    renderRow({ aiInsightsSuppressed: false, aiInsightsSuppressedAt: null });
    fireEvent.click(screen.getByRole('button', { name: 'stations.aiInsights.suppress' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'stations.aiInsights.suppress' });
    fireEvent.click(confirm);
    expect(within(dialog).getByText('stations.aiInsights.reasonRequired')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('stations.aiInsights.reason'), {
      target: { value: 'Site works' },
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/sta_1/ai-insights/suppress', {
        reason: 'Site works',
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'stations.aiInsights.suppressedToast',
      });
    });
  });

  it('shows who suppressed, until when and why, and resumes', async () => {
    perms.add('stations:write');
    apiMock.post.mockResolvedValue({});
    renderRow({
      aiInsightsSuppressed: true,
      aiInsightsSuppressedAt: '2026-10-15T10:00:00Z',
      aiInsightsSuppressedUntil: '2026-10-20T10:00:00Z',
      aiInsightsSuppressedByName: 'Ada Lovelace',
      aiInsightsSuppressedReason: 'Site works',
    });
    expect(screen.getByTestId('station-ai-insights-badge').textContent).toBe(
      'stations.aiInsights.suppressed',
    );
    expect(screen.getByTestId('station-ai-insights-detail').textContent).toBe(
      'stations.aiInsights.until(2026-10-20T10:00:00Z) · stations.aiInsights.by(Ada Lovelace,Site works)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'stations.aiInsights.resume' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.aiInsights.resume' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/sta_1/ai-insights/resume', {});
    });
  });

  it('shows the maintenance suppression without a Resume button', () => {
    perms.add('stations:write');
    renderRow({
      aiInsightsSuppressed: true,
      aiInsightsSuppressedByMaintenance: true,
      aiInsightsSuppressedAt: null,
    });
    expect(screen.getByText('stations.aiInsights.maintenance')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'stations.aiInsights.resume' })).toBeNull();
  });

  it('shows the suppression of its site with a site link and no Resume button', () => {
    perms.add('stations:write');
    renderRow({
      siteId: 'sit_1',
      siteName: 'Main Street',
      aiInsightsSuppressed: true,
      aiInsightsSuppressedSources: ['station', 'site'],
      aiInsightsSuppressedAt: '2026-10-15T10:00:00Z',
      aiInsightsSuppressedUntil: null,
      aiInsightsSuppressedByName: 'Ada Lovelace',
      aiInsightsSuppressedReason: 'Own reason',
    });
    const withSite = screen.getByTestId('station-ai-insights-with-site');
    expect(withSite.textContent).toContain('stations.aiInsights.withSite');
    const link = within(withSite).getByRole('link', { name: 'Main Street' });
    expect(link.getAttribute('href')).toBe('/sites/sit_1');
    // Its own suppression stays visible, kept for when the site resumes.
    expect(screen.getByTestId('station-ai-insights-detail').textContent).toContain(
      'stations.aiInsights.untilResumed',
    );
    expect(screen.queryByRole('button', { name: 'stations.aiInsights.resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'stations.aiInsights.suppress' })).toBeNull();
  });

  it('keeps Suppress for a station suppressed only with its site', () => {
    perms.add('stations:write');
    renderRow({
      siteId: 'sit_1',
      siteName: 'Main Street',
      aiInsightsSuppressed: true,
      aiInsightsSuppressedSources: ['site'],
      aiInsightsSuppressedAt: null,
    });
    expect(screen.getByTestId('station-ai-insights-badge').textContent).toBe(
      'stations.aiInsights.suppressed',
    );
    expect(screen.getByRole('button', { name: 'stations.aiInsights.suppress' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'stations.aiInsights.resume' })).toBeNull();
  });
});
