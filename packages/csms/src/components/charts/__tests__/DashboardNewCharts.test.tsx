// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The four charts of the Live dashboard that start hidden: loading, load
// error with Retry, empty and data.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { ApexOptions } from 'apexcharts';

const captured = vi.hoisted((): { options: ApexOptions | null; series: unknown } => ({
  options: null,
  series: null,
}));

vi.mock('react-apexcharts', () => ({
  default: (props: { options: ApexOptions; series: unknown }) => {
    captured.options = props.options;
    captured.series = props.series;
    return <div data-testid="apex" />;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { theme: string }) => unknown) => selector({ theme: 'light' }),
}));

import { LocationsByCityChart } from '../LocationsByCityChart';
import { EvsesByConnectorTypeChart } from '../EvsesByConnectorTypeChart';
import { PlugAndChargeChart } from '../PlugAndChargeChart';
import { FreeVendChart } from '../FreeVendChart';

afterEach(() => {
  cleanup();
  captured.options = null;
  captured.series = null;
});

const loading = { isLoading: true, isError: false, onRetry: () => undefined };
const days = [
  { date: '2026-10-25', sessionCount: 1, energyWh: 1500 },
  { date: '2026-10-26', sessionCount: 2, energyWh: 2500 },
];

describe('new dashboard charts', () => {
  it('shows the loading mark and the load error with Retry', () => {
    const { unmount } = render(<FreeVendChart data={undefined} state={loading} />);
    expect(screen.getByRole('status')).toBeTruthy();
    unmount();
    const onRetry = vi.fn();
    render(
      <EvsesByConnectorTypeChart data={[]} state={{ isLoading: false, isError: true, onRetry }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the empty text of each chart', () => {
    render(
      <LocationsByCityChart data={{ cities: [], other: { siteCount: 0, stationCount: 0 } }} />,
    );
    expect(screen.getByText('dashboard.noLocations')).toBeTruthy();
    cleanup();
    render(<EvsesByConnectorTypeChart data={[]} />);
    expect(screen.getByText('dashboard.noEvses')).toBeTruthy();
    cleanup();
    render(
      <PlugAndChargeChart
        data={{
          days: days.map((d) => ({ ...d, sessionCount: 0, energyWh: 0 })),
          totals: { sessionCount: 0, energyWh: 0 },
          activeContracts: null,
        }}
      />,
    );
    expect(screen.getByText('dashboard.noPlugAndChargeSessions')).toBeTruthy();
  });

  it('labels cities, puts the unknown city and the other cities last', () => {
    render(
      <LocationsByCityChart
        data={{
          cities: [
            { city: 'Austin', siteCount: 2, stationCount: 5 },
            { city: null, siteCount: 1, stationCount: 1 },
          ],
          other: { siteCount: 3, stationCount: 4 },
        }}
      />,
    );
    const xaxis = captured.options?.xaxis as { categories: string[] };
    expect(xaxis.categories).toEqual(['Austin', 'dashboard.unknownCity', 'dashboard.otherCities']);
    expect(captured.series).toEqual([{ name: 'dashboard.chartStations', data: [5, 1, 4] }]);
  });

  it('labels connector types and keeps an unlisted one as sent', () => {
    render(
      <EvsesByConnectorTypeChart
        data={[
          { connectorType: 'ccs2', evseCount: 3, connectorCount: 4 },
          { connectorType: 'unknown', evseCount: 1, connectorCount: 1 },
          { connectorType: 'mcs', evseCount: 1, connectorCount: 1 },
        ]}
      />,
    );
    const xaxis = captured.options?.xaxis as {
      categories: string[];
      labels: { rotate: number; hideOverlappingLabels: boolean; trim: boolean };
    };
    // Short standard names on the axis, so no label is rotated, hidden or clipped.
    expect(xaxis.categories).toEqual(['CCS2', 'stations.connectorUnknown', 'mcs']);
    expect(xaxis.labels).toEqual({ rotate: 0, hideOverlappingLabels: false, trim: false });
    // The tooltip names the full type.
    const tooltip = captured.options?.tooltip as {
      x: { formatter: (val: number, opts?: { dataPointIndex?: number }) => string };
    };
    expect(tooltip.x.formatter(0, { dataPointIndex: 0 })).toBe('CCS2 (Combined Charging System 2)');
    expect(tooltip.x.formatter(0, { dataPointIndex: 2 })).toBe('mcs');
  });

  it('keeps every listed connector type short enough for an unrotated axis', () => {
    const types = ['type1', 'ccs1', 'nacs', 'type2', 'ccs2', 'chademo', 'gbt'];
    render(
      <EvsesByConnectorTypeChart
        data={types.map((connectorType) => ({ connectorType, evseCount: 1, connectorCount: 1 }))}
      />,
    );
    const xaxis = captured.options?.xaxis as { categories: string[] };
    expect(xaxis.categories).toEqual([
      'Type 1',
      'CCS1',
      'NACS',
      'Type 2',
      'CCS2',
      'CHAdeMO',
      'GB/T',
    ]);
  });

  it('shows sessions and energy per day, with the active contracts only when given', () => {
    render(
      <PlugAndChargeChart
        data={{ days, totals: { sessionCount: 3, energyWh: 4000 }, activeContracts: 7 }}
      />,
    );
    expect(screen.getByText('dashboard.activeContractsCount {"value":"7"}')).toBeTruthy();
    expect(captured.series).toEqual([
      { name: 'charts.sessions', type: 'column', data: [1, 2] },
      { name: 'charts.energy', type: 'line', data: [1.5, 2.5] },
    ]);
    cleanup();
    render(
      <PlugAndChargeChart
        data={{ days, totals: { sessionCount: 3, energyWh: 4000 }, activeContracts: null }}
      />,
    );
    expect(screen.queryByText(/dashboard\.activeContractsCount/)).toBeNull();
  });

  it('shows the free vend sites', () => {
    render(
      <FreeVendChart
        data={{ days, totals: { sessionCount: 3, energyWh: 4000 }, freeVendSiteCount: 2 }}
      />,
    );
    expect(screen.getByText('dashboard.freeVendSites {"value":"2"}')).toBeTruthy();
    expect(screen.getByTestId('apex')).toBeTruthy();
  });
});
