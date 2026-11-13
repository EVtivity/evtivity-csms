// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), put: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { Tabs } from '@/components/ui/tabs';
import { SiteAutochargeTab } from '../SiteAutochargeTab';
import { SiteCarbonRegionTab } from '../SiteCarbonRegionTab';
import { SiteDataPlanTab } from '../SiteDataPlanTab';

function renderIn(tab: string, node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Tabs value={tab} onValueChange={() => undefined}>
        {node}
      </Tabs>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  perms.clear();
  vi.clearAllMocks();
});

describe('SiteAutochargeTab', () => {
  it('is read-only without sites:write', () => {
    renderIn(
      'autocharge',
      <SiteAutochargeTab site={{ id: 's1', autochargeEnabled: false }} siteId="s1" />,
    );
    const select = screen.getByLabelText('sites.autocharge');
    expect(select).toHaveProperty('disabled', true);
    expect((select as HTMLSelectElement).value).toBe('off');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the panel title and description and saves the site override', async () => {
    perms.add('sites:write');
    apiMock.patch.mockResolvedValue({});
    renderIn('autocharge', <SiteAutochargeTab site={{ id: 's1' }} siteId="s1" />);
    expect(screen.getByText('sites.autochargeDescription')).toBeTruthy();
    const select = screen.getByLabelText('sites.autocharge');
    expect((select as HTMLSelectElement).value).toBe('');
    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/s1', { autochargeEnabled: false });
    });
  });

  it('sends null for Use Company Setting', async () => {
    perms.add('sites:write');
    apiMock.patch.mockResolvedValue({});
    renderIn(
      'autocharge',
      <SiteAutochargeTab site={{ id: 's1', autochargeEnabled: true }} siteId="s1" />,
    );
    fireEvent.change(screen.getByLabelText('sites.autocharge'), { target: { value: '' } });
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/s1', { autochargeEnabled: null });
    });
  });
});

describe('SiteCarbonRegionTab', () => {
  const factors = [
    {
      id: 1,
      regionCode: 'US-CA',
      regionName: 'California',
      countryCode: 'US',
      carbonIntensityKgPerKwh: '0.2',
      source: 'x',
    },
  ];

  it('is locked without sites:write', async () => {
    apiMock.get.mockResolvedValue(factors);
    renderIn(
      'carbon-region',
      <SiteCarbonRegionTab site={{ id: 's1', carbonRegionCode: 'US-CA' }} siteId="s1" />,
    );
    expect(screen.getByLabelText('sites.carbonRegion')).toHaveProperty('disabled', true);
    expect(await screen.findByText(/sites.carbonIntensity: 200 g/)).toBeTruthy();
  });

  it('saves the region with sites:write', async () => {
    perms.add('sites:write');
    apiMock.get.mockResolvedValue(factors);
    apiMock.put.mockResolvedValue({});
    renderIn(
      'carbon-region',
      <SiteCarbonRegionTab site={{ id: 's1', carbonRegionCode: null }} siteId="s1" />,
    );
    await screen.findByText(/California/);
    fireEvent.change(screen.getByLabelText('sites.carbonRegion'), { target: { value: 'US-CA' } });
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/sites/s1/carbon-region', {
        regionCode: 'US-CA',
      });
    });
  });
});

describe('SiteDataPlanTab', () => {
  it('shows the site data plan card in its tab', () => {
    renderIn('data-plan', <SiteDataPlanTab siteId="s1" dataPlan="cellular" />);
    expect(screen.getByText('dataPlan.plans.cellular')).toBeTruthy();
  });
});
