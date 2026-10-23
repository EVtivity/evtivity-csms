// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Site revenue, tax, cost and profit need payments:read, as the API (which
// answers them null without it): the tiles and the revenue chart are hidden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { perms, getMock } = vi.hoisted(() => ({
  perms: new Set<string>(),
  getMock: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/components/ui/tabs', () => ({
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/charts/StationPowerChart', () => ({ StationPowerChart: () => null }));
vi.mock('@/components/charts/StationEnergyChart', () => ({ StationEnergyChart: () => null }));
vi.mock('@/components/charts/PopularTimesChart', () => ({ PopularTimesChart: () => null }));
vi.mock('@/components/charts/RevenueChart', () => ({
  RevenueChart: () => <div>revenue-chart</div>,
}));

import { SiteMetricsTab } from '../site/SiteMetricsTab';

const METRICS = {
  uptimePercent: 100,
  portCount: 2,
  utilizationPercent: 10,
  totalSessions: 3,
  completedSessions: 3,
  faultedSessions: 0,
  sessionSuccessPercent: 100,
  totalEnergyWh: 1000,
  avgSessionDurationMinutes: 30,
  disconnectCount: 0,
  avgDowntimeMinutes: 0,
  maxDowntimeMinutes: 0,
  totalRevenueCents: null,
  avgRevenueCentsPerSession: null,
  totalTransactions: 3,
  totalElectricityCostCents: null,
  totalNetRevenueCents: null,
  totalTaxCents: null,
  totalProfitCents: null,
  costMissingSessionCount: 0,
  costMissingRevenueCents: null,
  periodMonths: 12,
  currency: 'USD',
};

beforeEach(() => {
  perms.clear();
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/metrics') ? METRICS : []),
  );
});

afterEach(() => {
  cleanup();
});

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SiteMetricsTab siteId="sit_1" />
    </QueryClientProvider>,
  );
}

describe('SiteMetricsTab money', () => {
  it('hides revenue, cost and profit and the revenue chart without payments:read', async () => {
    renderTab();
    expect(await screen.findByText('metrics.maxDowntime')).toBeDefined();
    expect(screen.queryByText('metrics.totalRevenue')).toBeNull();
    expect(screen.queryByText('metrics.profit')).toBeNull();
    expect(screen.queryByText('revenue-chart')).toBeNull();
  });

  it('shows them with payments:read', async () => {
    perms.add('payments:read');
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/metrics')
          ? { ...METRICS, totalRevenueCents: 500, totalProfitCents: 100 }
          : [],
      ),
    );
    renderTab();
    expect(await screen.findByText('metrics.totalRevenue')).toBeDefined();
    expect(screen.getByText('revenue-chart')).toBeDefined();
  });
});
