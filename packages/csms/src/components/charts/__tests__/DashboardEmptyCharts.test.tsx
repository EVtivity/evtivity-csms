// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Dashboard chart cards without data: donuts draw an empty ring with a total
// of 0, every card body keeps the chart height while empty or loading, so a
// card without data is as tall as the cards next to it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('react-apexcharts', () => ({
  default: () => <div data-testid="apex" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { theme: string }) => unknown) => selector({ theme: 'light' }),
}));

import { CHART_HEIGHT } from '../ChartBody';
import { PaymentBreakdownChart } from '../PaymentBreakdownChart';
import { StationStatusChart } from '../StationStatusChart';
import { EnergyChart } from '../EnergyChart';
import { SessionsChart } from '../SessionsChart';
import { RevenueChart } from '../RevenueChart';
import { UtilizationChart } from '../UtilizationChart';
import { PeakUsageChart } from '../PeakUsageChart';
import { LocationsByCityChart } from '../LocationsByCityChart';
import { EvsesByConnectorTypeChart } from '../EvsesByConnectorTypeChart';
import { PlugAndChargeChart } from '../PlugAndChargeChart';
import { FreeVendChart } from '../FreeVendChart';

afterEach(cleanup);

const chartHeight = `${String(CHART_HEIGHT)}px`;

function expectChartHeight(): void {
  expect(screen.queryByTestId('apex')).toBeNull();
  expect(screen.getByTestId('chart-placeholder').style.minHeight).toBe(chartHeight);
}

describe('dashboard charts without data', () => {
  it('draws the payment breakdown as an empty ring with a total of 0 at the chart height', () => {
    render(<PaymentBreakdownChart data={[]} />);
    expect(screen.getByTestId('empty-donut')).toBeTruthy();
    expect(screen.getByText('charts.noPayments')).toBeTruthy();
    expect(screen.getByText('charts.total')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expectChartHeight();
  });

  it('draws the station status as an empty ring at the chart height', () => {
    render(<StationStatusChart data={[]} />);
    expect(screen.getByTestId('empty-donut')).toBeTruthy();
    expect(screen.getByText('charts.noConnectors')).toBeTruthy();
    expectChartHeight();
  });

  it('keeps the chart height for every other empty chart card', () => {
    const empties: [string, React.JSX.Element][] = [
      ['energy', <EnergyChart key="e" data={[]} />],
      ['sessions', <SessionsChart key="s" data={[]} />],
      ['revenue', <RevenueChart key="r" data={[]} currency="USD" />],
      ['utilization', <UtilizationChart key="u" data={[]} />],
      ['peak usage', <PeakUsageChart key="p" data={[]} />],
      ['locations', <LocationsByCityChart key="l" data={undefined} />],
      ['connector types', <EvsesByConnectorTypeChart key="c" data={[]} />],
      ['plug and charge', <PlugAndChargeChart key="pc" data={undefined} />],
      ['free vend', <FreeVendChart key="f" data={undefined} />],
    ];
    for (const [name, element] of empties) {
      const { unmount } = render(element);
      expect(screen.getByTestId('empty-state'), name).toBeTruthy();
      expectChartHeight();
      unmount();
    }
  });

  it('keeps the chart height while loading and on a load error', () => {
    const { unmount } = render(
      <PaymentBreakdownChart
        data={[]}
        state={{ isLoading: true, isError: false, onRetry: () => undefined }}
      />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expectChartHeight();
    unmount();
    render(
      <PaymentBreakdownChart
        data={[]}
        state={{ isLoading: false, isError: true, onRetry: () => undefined }}
      />,
    );
    expect(screen.getByText('common.retry')).toBeTruthy();
    expectChartHeight();
  });

  it('keeps the chart height while the revenue currency loads', () => {
    render(
      <RevenueChart
        data={[{ date: '2026-11-01', revenueCents: 100, sessionCount: 1 }]}
        currency={undefined}
      />,
    );
    expectChartHeight();
  });

  it('draws the chart once there is data', () => {
    render(<PaymentBreakdownChart data={[{ status: 'captured', count: 2, totalCents: 500 }]} />);
    expect(screen.getByTestId('apex')).toBeTruthy();
    expect(screen.queryByTestId('chart-placeholder')).toBeNull();
  });
});
