// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), put: vi.fn() },
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { Tabs } from '@/components/ui/tabs';
import { SiteAutochargeTab } from '../SiteAutochargeTab';
import { SiteCarbonRegionTab } from '../SiteCarbonRegionTab';

function renderIn(value: string, child: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Tabs value={value} onValueChange={() => {}}>
        {child}
      </Tabs>
    </QueryClientProvider>,
  );
}

const FACTOR = {
  id: 1,
  regionCode: 'US-CAL',
  regionName: 'California',
  countryCode: 'US',
  carbonIntensityKgPerKwh: '0.2',
  source: 'EPA',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteAutochargeTab', () => {
  it('says the change was saved', async () => {
    apiMock.patch.mockResolvedValue({});
    renderIn('autocharge', <SiteAutochargeTab site={{ id: 's1' }} siteId="s1" />);
    fireEvent.change(screen.getByLabelText('sites.autocharge'), { target: { value: 'on' } });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'common.saved' });
    });
    expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/s1', { autochargeEnabled: true });
  });
});

describe('SiteCarbonRegionTab', () => {
  it('shows the loading state, not No Carbon Region, while the regions load', () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    renderIn(
      'carbon-region',
      <SiteCarbonRegionTab site={{ id: 's1', carbonRegionCode: 'US-CAL' }} siteId="s1" />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('sites.noCarbonRegion')).toBeNull();
  });

  it('shows the error with Retry when the regions fail to load', async () => {
    apiMock.get.mockRejectedValueOnce(new Error('down'));
    renderIn(
      'carbon-region',
      <SiteCarbonRegionTab site={{ id: 's1', carbonRegionCode: 'US-CAL' }} siteId="s1" />,
    );
    await screen.findByTestId('error-state');
    expect(screen.queryByText('sites.noCarbonRegion')).toBeNull();
    apiMock.get.mockResolvedValue([FACTOR]);
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('sites.carbonRegion').value).toBe('US-CAL');
    });
  });

  it('says the change was saved', async () => {
    apiMock.get.mockResolvedValue([FACTOR]);
    apiMock.put.mockResolvedValue({});
    renderIn(
      'carbon-region',
      <SiteCarbonRegionTab site={{ id: 's1', carbonRegionCode: null }} siteId="s1" />,
    );
    const select = await screen.findByLabelText('sites.carbonRegion');
    fireEvent.change(select, { target: { value: 'US-CAL' } });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'common.saved' });
    });
  });
});
