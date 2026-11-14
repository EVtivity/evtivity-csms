// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count != null ? `${key}:${String(opts.count)}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { TariffScopeFields, TariffSitesSummary, type TariffScopeValue } from '../TariffScopeFields';
import { MaxPowerKindHint } from '../../station/MaxPowerKindHint';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The site list for a search, and the sites named by `ids`. */
function mockSites(sites: Array<{ id: string; name: string }>): void {
  getMock.mockImplementation((url: string) => {
    const params = new URL(url, 'http://x').searchParams;
    const ids = params.get('ids');
    if (ids != null) {
      const wanted = ids.split(',');
      return Promise.resolve({ data: sites.filter((x) => wanted.includes(x.id)) });
    }
    const search = params.get('search') ?? '';
    return Promise.resolve({ data: sites.filter((x) => x.name.includes(search)) });
  });
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function Harness({
  allowed,
  onValue,
}: {
  allowed: boolean;
  onValue: (v: TariffScopeValue) => void;
}) {
  const [value, setValue] = useState<TariffScopeValue>({ chargingType: 'both', siteIds: null });
  return (
    <TariffScopeFields
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      siteAvailabilityAllowed={allowed}
      idPrefix="t"
    />
  );
}

describe('TariffScopeFields', () => {
  it('sets the charging type and picks selected sites', async () => {
    mockSites([{ id: 'sit_a', name: 'Site A' }]);
    const onValue = vi.fn();
    wrap(<Harness allowed onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('pricing.chargingType'), { target: { value: 'dc' } });
    expect(onValue).toHaveBeenLastCalledWith({ chargingType: 'dc', siteIds: null });
    fireEvent.change(screen.getByLabelText('pricing.siteAvailability'), {
      target: { value: 'selected' },
    });
    expect(onValue).toHaveBeenLastCalledWith({ chargingType: 'dc', siteIds: [] });
    fireEvent.click(await screen.findByLabelText('Site A'));
    expect(onValue).toHaveBeenLastCalledWith({ chargingType: 'dc', siteIds: ['sit_a'] });
  });

  it('finds a site by search and keeps the selected sites listed by name', async () => {
    mockSites([
      { id: 'sit_a', name: 'Alpha Depot' },
      { id: 'sit_b', name: 'Beta Garage' },
    ]);
    const onValue = vi.fn();
    wrap(<Harness allowed onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('pricing.siteAvailability'), {
      target: { value: 'selected' },
    });
    fireEvent.change(screen.getByLabelText('sites.search'), { target: { value: 'Beta' } });
    fireEvent.click(await screen.findByLabelText('Beta Garage'));
    expect(onValue).toHaveBeenLastCalledWith({ chargingType: 'both', siteIds: ['sit_b'] });
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(expect.stringContaining('search=Beta'));
    });
    // A new search that does not match it still lists the picked site, read by its id.
    fireEvent.change(screen.getByLabelText('sites.search'), { target: { value: 'Alpha' } });
    expect(await screen.findByLabelText('Alpha Depot')).toBeTruthy();
    expect(screen.getByLabelText('Beta Garage')).toHaveProperty('checked', true);
  });

  it('explains why a station or site group has no Site Availability', () => {
    wrap(<Harness allowed={false} onValue={vi.fn()} />);
    expect(screen.queryByLabelText('pricing.siteAvailability')).toBeNull();
    expect(screen.getByText('pricing.siteAvailabilityNotAllowed')).toBeTruthy();
  });
});

describe('TariffSitesSummary', () => {
  it('names the sites and counts the ones the reader may not see', async () => {
    mockSites([{ id: 'sit_a', name: 'Site A' }]);
    wrap(<TariffSitesSummary siteIds={['sit_a']} otherSiteCount={2} />);
    await waitFor(() => {
      expect(screen.getByText('Site A, pricing.otherSites:2')).toBeTruthy();
    });
  });

  it('reads the names of every selected site in one request', async () => {
    mockSites([
      { id: 'sit_a', name: 'Site A' },
      { id: 'sit_b', name: 'Site B' },
      { id: 'sit_c', name: 'Site C' },
    ]);
    wrap(<TariffSitesSummary siteIds={['sit_c', 'sit_a', 'sit_b']} />);
    await waitFor(() => {
      expect(screen.getByText('Site C, Site A, Site B')).toBeTruthy();
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/v1/sites?ids=sit_a,sit_b,sit_c&limit=100');
  });

  it('shows All Sites for a tariff without a site list', () => {
    wrap(<TariffSitesSummary siteIds={null} />);
    expect(screen.getByText('pricing.allSites')).toBeTruthy();
  });
});

describe('MaxPowerKindHint', () => {
  it('shows the AC or DC hint for NACS, GB/T and Tesla only', () => {
    for (const type of ['NACS', 'GBT', 'Tesla']) {
      const { unmount } = render(<MaxPowerKindHint connectorType={type} />);
      expect(screen.getByText('stations.maxPowerKindHint')).toBeTruthy();
      unmount();
    }
    for (const type of ['CCS2', 'Type2', null]) {
      const { container, unmount } = render(<MaxPowerKindHint connectorType={type} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });
});
