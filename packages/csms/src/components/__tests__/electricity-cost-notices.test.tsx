// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { postMock, toastMock, permission } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null
        ? key
        : `${key}(${Object.entries(opts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')})`,
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return { api: { post: postMock, get: vi.fn() }, ApiError };
});
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import {
  CostMissingDashboardNotice,
  RecalculateElectricityCostAction,
  costMissingSessionsPath,
  orderCostMissingSites,
  MAX_COST_MISSING_SITE_ROWS,
  type CostMissingSite,
} from '../ElectricityCostNotices';
import { RecalculateButton } from '../recalculate-button';

const SITES: CostMissingSite[] = [
  {
    siteId: 'sit_rates',
    siteName: 'Residential Complex',
    hasRatePeriods: true,
    sessionCount: 4,
    revenueCents: 1200,
  },
  {
    siteId: 'sit_norates',
    siteName: 'Depot',
    hasRatePeriods: false,
    sessionCount: 2,
    revenueCents: 300,
  },
];

function wrap(node: React.ReactNode): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
  toastMock.mockReset();
  permission.canWrite = true;
});

describe('CostMissingDashboardNotice', () => {
  it('tells a site without rates from a site whose sessions miss a cost', () => {
    wrap(
      <CostMissingDashboardNotice
        sessionCount={6}
        revenueCents={1500}
        currency="USD"
        sites={SITES}
      />,
    );
    const rows = screen.getAllByTestId('cost-missing-site');
    expect(rows).toHaveLength(2);

    // A site without rates comes first: the whole row links to its rate settings, no Recalculate.
    expect(rows[0]?.textContent).toBe('dashboard.costMissingNoRates(site=Depot) (2)');
    expect(rows[0]?.getAttribute('href')).toBe('/sites/sit_norates?tab=electricity-rates');

    const withRates = within(rows[1] as HTMLElement).getByRole('link');
    expect(withRates.textContent).toBe(
      'dashboard.costMissingSessions(count=4,site=Residential Complex)',
    );
    expect(withRates.getAttribute('href')).toBe('/sessions?siteId=sit_rates&costMissing=true');
    expect(
      within(rows[1] as HTMLElement).getByRole('button', {
        name: 'sites.electricityCostRecalculate',
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'sites.electricityCostRecalculate' }),
    ).toHaveLength(1);
  });

  it('keeps the shared stat card design (warning tone, stat header, card list)', () => {
    wrap(
      <CostMissingDashboardNotice
        sessionCount={6}
        revenueCents={1500}
        currency="USD"
        sites={SITES}
      />,
    );
    const card = screen.getByTestId('cost-missing-notice');
    expect(card.querySelector('h3')?.textContent).toBe('dashboard.costMissingTitle');
    expect(card.querySelector('ul')).not.toBeNull();
  });

  it('is hidden without sites:write', () => {
    permission.canWrite = false;
    wrap(
      <CostMissingDashboardNotice
        sessionCount={6}
        revenueCents={1500}
        currency="USD"
        sites={SITES}
      />,
    );
    expect(screen.queryByTestId('cost-missing-notice')).toBeNull();
  });

  it('shows at most 5 sites, without rates first, then the most sessions, and links the rest', () => {
    const many: CostMissingSite[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        siteId: `sit_r${String(i)}`,
        siteName: `Rated ${String(i)}`,
        hasRatePeriods: true,
        sessionCount: i + 1,
        revenueCents: 100,
      })),
      {
        siteId: 'sit_n',
        siteName: 'No Rates',
        hasRatePeriods: false,
        sessionCount: 1,
        revenueCents: 1,
      },
    ];
    expect(orderCostMissingSites(many).map((s) => s.siteId)).toEqual([
      'sit_n',
      'sit_r5',
      'sit_r4',
      'sit_r3',
      'sit_r2',
      'sit_r1',
      'sit_r0',
    ]);
    wrap(
      <CostMissingDashboardNotice
        sessionCount={22}
        revenueCents={700}
        currency="USD"
        sites={many}
      />,
    );
    const rows = screen.getAllByTestId('cost-missing-site');
    expect(rows).toHaveLength(MAX_COST_MISSING_SITE_ROWS);
    expect(rows[0]?.textContent).toBe('dashboard.costMissingNoRates(site=No Rates) (1)');
    const more = screen.getByTestId('cost-missing-more');
    expect(more.textContent).toBe('dashboard.costMissingMoreSites(count=2)');
    expect(more.getAttribute('href')).toBe('/sessions?costMissing=true');
  });

  it('has no footer when every site fits', () => {
    wrap(
      <CostMissingDashboardNotice
        sessionCount={6}
        revenueCents={1500}
        currency="USD"
        sites={SITES}
      />,
    );
    expect(screen.queryByTestId('cost-missing-more')).toBeNull();
  });

  it('links to the filtered sessions list', () => {
    expect(costMissingSessionsPath('sit_a b')).toBe('/sessions?siteId=sit_a%20b&costMissing=true');
  });
});

describe('RecalculateElectricityCostAction', () => {
  it('confirms, repeats the request while costs remain, toasts the total and refreshes', async () => {
    postMock
      .mockResolvedValueOnce({ updated: 5000, remaining: 3 })
      .mockResolvedValueOnce({ updated: 2, remaining: 1 })
      .mockResolvedValueOnce({ updated: 0, remaining: 1 });
    const queryClient = wrap(
      <RecalculateElectricityCostAction siteId="sit_rates" siteName="Residential Complex" />,
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByRole('button', { name: 'sites.electricityCostRecalculate' }));
    expect(
      screen.getByText('sites.electricityCostRecalculateConfirm(site=Residential Complex)'),
    ).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'sites.electricityCostRecalculate' }),
    );

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sites.electricityCostRecalculated(count=5002)',
        description: 'sites.electricityCostRecalculateRemaining(count=1)',
        variant: 'success',
      });
    });
    expect(postMock).toHaveBeenCalledTimes(3);
    expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_rates/electricity-cost/recalculate', {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dashboard'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sites', 'sit_rates'] });
  });

  it('sends nothing until confirmed and says when no session got a cost', async () => {
    postMock.mockResolvedValueOnce({ updated: 0, remaining: 0 });
    wrap(<RecalculateElectricityCostAction siteId="sit_rates" siteName="Residential Complex" />);
    fireEvent.click(screen.getByRole('button', { name: 'sites.electricityCostRecalculate' }));
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'sites.electricityCostRecalculate',
      }),
    );
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sites.electricityCostRecalculateNone',
        variant: 'default',
      });
    });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('stops after 20 requests and asks to run it again while costs are still being filled', async () => {
    postMock.mockResolvedValue({ updated: 5000, remaining: 7 });
    wrap(<RecalculateElectricityCostAction siteId="sit_rates" siteName="Residential Complex" />);
    fireEvent.click(screen.getByRole('button', { name: 'sites.electricityCostRecalculate' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'sites.electricityCostRecalculate',
      }),
    );
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sites.electricityCostRecalculated(count=100000)',
        description: 'sites.electricityCostRecalculateMore(count=7)',
        variant: 'success',
      });
    });
    expect(postMock).toHaveBeenCalledTimes(20);
  });

  it('is hidden without sites:write', () => {
    permission.canWrite = false;
    wrap(<RecalculateElectricityCostAction siteId="sit_rates" siteName="Residential Complex" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('RecalculateButton', () => {
  it('is the shared outline Button with its icon and label', () => {
    const onClick = vi.fn();
    render(<RecalculateButton label="Recalculate" onClick={onClick} size="sm" />);
    const button = screen.getByRole('button', { name: 'Recalculate' });
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
