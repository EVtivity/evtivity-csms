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
    getMock.mockResolvedValue({ data: [{ id: 'sit_a', name: 'Site A' }] });
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

  it('explains why a station or site group has no Site Availability', () => {
    wrap(<Harness allowed={false} onValue={vi.fn()} />);
    expect(screen.queryByLabelText('pricing.siteAvailability')).toBeNull();
    expect(screen.getByText('pricing.siteAvailabilityNotAllowed')).toBeTruthy();
  });
});

describe('TariffSitesSummary', () => {
  it('names the sites and counts the ones the reader may not see', async () => {
    getMock.mockResolvedValue({ data: [{ id: 'sit_a', name: 'Site A' }] });
    wrap(<TariffSitesSummary siteIds={['sit_a']} otherSiteCount={2} />);
    await waitFor(() => {
      expect(screen.getByText('Site A, pricing.otherSites:2')).toBeTruthy();
    });
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
