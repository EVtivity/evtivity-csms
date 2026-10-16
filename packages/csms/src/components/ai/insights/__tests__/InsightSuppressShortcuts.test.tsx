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

import { InsightSuppressShortcuts } from '../InsightSuppressShortcuts';

interface Records {
  station?: Record<string, unknown>;
  site?: Record<string, unknown>;
}

function mockRecords(records: Records): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith('/v1/stations/')) return Promise.resolve(records.station ?? {});
    if (url.startsWith('/v1/sites/')) return Promise.resolve(records.site ?? {});
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderShortcuts(stationId: string | null, siteId: string | null): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <dl>
        <InsightSuppressShortcuts stationId={stationId} siteId={siteId} timezone="UTC" />
      </dl>
    </QueryClientProvider>,
  );
  return client;
}

const READ = ['stations:read', 'sites:read'];

beforeEach(() => {
  perms.clear();
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('InsightSuppressShortcuts', () => {
  it('offers both buttons for a station insight, the site taken from the station', async () => {
    for (const p of [...READ, 'stations:write', 'sites:write']) perms.add(p);
    mockRecords({
      station: { siteId: 'sit_1', aiInsightsSuppressedSources: [] },
      site: { aiInsightsSuppressedAt: null },
    });
    renderShortcuts('sta_1', null);
    expect(
      await screen.findByRole('button', { name: 'aiInsights.detail.suppressStation' }),
    ).toBeDefined();
    expect(
      await screen.findByRole('button', { name: 'aiInsights.detail.suppressSite' }),
    ).toBeDefined();
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/sit_1');
    });
  });

  it('hides each button without its write permission', async () => {
    for (const p of [...READ, 'sites:write']) perms.add(p);
    mockRecords({
      station: { siteId: 'sit_1', aiInsightsSuppressedSources: [] },
      site: { aiInsightsSuppressedAt: null },
    });
    renderShortcuts('sta_1', 'sit_1');
    expect(
      await screen.findByRole('button', { name: 'aiInsights.detail.suppressSite' }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'aiInsights.detail.suppressStation' })).toBeNull();
  });

  it('renders nothing without write permissions or suppressed records', async () => {
    perms.add('stations:read');
    mockRecords({ station: { siteId: null, aiInsightsSuppressedSources: [] } });
    renderShortcuts('sta_1', null);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('insight-suppress-shortcuts')).toBeNull();
  });

  it('shows the state of an already suppressed station and site instead of the buttons', async () => {
    for (const p of [...READ, 'stations:write', 'sites:write']) perms.add(p);
    mockRecords({
      station: {
        siteId: 'sit_1',
        aiInsightsSuppressedSources: ['station', 'site'],
        aiInsightsSuppressedUntil: '2030-01-01T00:00:00Z',
      },
      site: { aiInsightsSuppressedAt: '2026-10-15T00:00:00Z', aiInsightsSuppressedUntil: null },
    });
    renderShortcuts('sta_1', 'sit_1');
    expect((await screen.findByTestId('insight-station-suppressed')).textContent).toBe(
      'aiInsights.detail.stationSuppressedUntil(2030-01-01T00:00:00Z)',
    );
    expect((await screen.findByTestId('insight-site-suppressed')).textContent).toBe(
      'aiInsights.detail.siteSuppressedUntilResumed',
    );
    expect(screen.queryByRole('button', { name: 'aiInsights.detail.suppressStation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiInsights.detail.suppressSite' })).toBeNull();
  });

  it('shows a station suppressed with its site, offering no station action', async () => {
    for (const p of [...READ, 'stations:write', 'sites:write']) perms.add(p);
    mockRecords({
      station: { siteId: 'sit_1', aiInsightsSuppressedSources: ['site'] },
      site: { aiInsightsSuppressedAt: '2026-10-15T00:00:00Z', aiInsightsSuppressedUntil: null },
    });
    renderShortcuts('sta_1', 'sit_1');
    expect((await screen.findByTestId('insight-station-suppressed')).textContent).toBe(
      'aiInsights.detail.stationSuppressedWithSite',
    );
    expect(screen.queryByRole('button', { name: 'aiInsights.detail.suppressStation' })).toBeNull();
  });

  it('suppresses the site from the insight and refreshes the insight', async () => {
    for (const p of [...READ, 'sites:write']) perms.add(p);
    mockRecords({ site: { aiInsightsSuppressedAt: null } });
    apiMock.post.mockResolvedValue({});
    const client = renderShortcuts(null, 'sit_1');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'aiInsights.detail.suppressSite' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('sites.aiInsights.suppressTitle')).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText('stations.aiInsights.reason'), {
      target: { value: 'Rebuild' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'sites.aiInsights.suppress' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sites/sit_1/ai-insights/suppress', {
        reason: 'Rebuild',
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'sites.aiInsights.suppressedToast',
      });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ai', 'insights'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sites'] });
  });

  it('suppresses the station from the insight', async () => {
    for (const p of [...READ, 'stations:write']) perms.add(p);
    mockRecords({ station: { siteId: null, aiInsightsSuppressedSources: [] } });
    apiMock.post.mockResolvedValue({});
    renderShortcuts('sta_1', null);
    fireEvent.click(
      await screen.findByRole('button', { name: 'aiInsights.detail.suppressStation' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('stations.aiInsights.reason'), {
      target: { value: 'Swap' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.aiInsights.suppress' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/sta_1/ai-insights/suppress', {
        reason: 'Swap',
      });
    });
  });
});
