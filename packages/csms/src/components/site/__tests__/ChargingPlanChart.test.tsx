// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ApexOptions } from 'apexcharts';

const captured: { options?: ApexOptions; series?: Array<{ name: string; type: string }> } = {};

vi.mock('react-apexcharts', () => ({
  default: (props: { options: ApexOptions; series: Array<{ name: string; type: string }> }) => {
    captured.options = props.options;
    captured.series = props.series;
    return <div data-testid="apex" />;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: { theme: string }) => unknown) => select({ theme: 'light' }),
}));

import { buildPlanChartData, ChargingPlanChart, planEntries } from '../ChargingPlanChart';
import { SERIES_COLORS, SERIES_OTHER_COLOR, REFERENCE_LINE_COLOR } from '@/lib/chart-theme';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const SLOT = 15 * 60_000;
const slotStarts = Array.from({ length: 4 * 48 }, (_, i) => new Date(NOW + i * SLOT).toISOString());

afterEach(() => {
  cleanup();
  delete captured.options;
  delete captured.series;
});

describe('buildPlanChartData', () => {
  it('keeps the slots of the next 24 hours, one series per vehicle and the capacity', () => {
    const data = buildPlanChartData(
      {
        slotStarts,
        plan: [
          { departureId: 'vdp_1', powerKw: slotStarts.map(() => 50) },
          { departureId: 'vdp_2', powerKw: slotStarts.map(() => 25) },
          { notAnEntry: true },
        ],
        capacityKw: slotStarts.map(() => 300),
        pricePerKwh: null,
      },
      (id) => `label-${id}`,
      'Other',
      NOW,
    );
    expect(data.slots).toHaveLength(96);
    expect(data.vehicles.map((v) => v.name)).toEqual(['label-vdp_1', 'label-vdp_2']);
    expect(data.vehicles[0]?.data.every((v) => v === 50)).toBe(true);
    expect(data.capacity.every((v) => v === 300)).toBe(true);
    expect(data.highPrice).toEqual([]);
  });

  it('folds the vehicles past the palette into Other, summing their power', () => {
    const plan = Array.from({ length: 9 }, (_, i) => ({
      departureId: `vdp_${String(i)}`,
      powerKw: [10, 10],
    }));
    const data = buildPlanChartData(
      { slotStarts: slotStarts.slice(0, 2), plan, capacityKw: null, pricePerKwh: null },
      (id) => id,
      'Other',
      NOW,
    );
    expect(data.vehicles).toHaveLength(SERIES_COLORS.light.length);
    const other = data.vehicles.at(-1);
    expect(other?.other).toBe(true);
    // Seven slots in the palette: six named vehicles, the other three summed.
    expect(other?.data).toEqual([30, 30]);
  });

  it('marks the slots above the median price as higher-price bands, merged when adjacent', () => {
    const prices = [0.1, 0.1, 0.3, 0.3, 0.1, 0.3];
    const data = buildPlanChartData(
      {
        slotStarts: slotStarts.slice(0, 6),
        plan: [],
        capacityKw: null,
        pricePerKwh: prices,
      },
      (id) => id,
      'Other',
      NOW,
    );
    expect(data.highPrice).toEqual([
      { from: NOW + 2 * SLOT, to: NOW + 4 * SLOT },
      { from: NOW + 5 * SLOT, to: NOW + 6 * SLOT },
    ]);
  });

  it('draws no band when every slot has the same price', () => {
    const data = buildPlanChartData(
      {
        slotStarts: slotStarts.slice(0, 3),
        plan: [],
        capacityKw: null,
        pricePerKwh: [0.2, 0.2, 0.2],
      },
      (id) => id,
      'Other',
      NOW,
    );
    expect(data.highPrice).toEqual([]);
  });

  it('reads only well-formed plan entries', () => {
    expect(planEntries(null)).toEqual([]);
    expect(planEntries([{ departureId: 'vdp_1', powerKw: [1, 'x', null] }])).toEqual([
      { departureId: 'vdp_1', powerKw: [1, 0, 0] },
    ]);
  });
});

describe('ChargingPlanChart', () => {
  it('stacks the vehicles as bars and draws the capacity as a dashed line on the same axis', () => {
    render(
      <ChargingPlanChart
        input={{
          slotStarts: slotStarts.slice(0, 4),
          plan: [{ departureId: 'vdp_1', powerKw: [10, 20, 30, 40] }],
          capacityKw: [100, 100, 100, 100],
          pricePerKwh: [0.1, 0.4, 0.1, 0.1],
        }}
        labelOf={() => 'BUS-12'}
        timezone="UTC"
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId('apex')).toBeTruthy();
    expect(captured.series?.map((s) => [s.name, s.type])).toEqual([
      ['BUS-12', 'bar'],
      ['sites.fleetReadiness.siteCapacity', 'line'],
    ]);
    expect(captured.options?.chart?.stacked).toBe(true);
    expect(captured.options?.chart?.stackOnlyBar).toBe(true);
    // One y-axis only: the price is a band, never a second scale.
    expect(Array.isArray(captured.options?.yaxis)).toBe(false);
    expect(captured.options?.colors).toEqual([SERIES_COLORS.light[0], REFERENCE_LINE_COLOR.light]);
    expect(captured.options?.annotations?.xaxis).toHaveLength(1);
    expect(screen.getByText('sites.fleetReadiness.priceBandNote')).toBeTruthy();
    expect(SERIES_OTHER_COLOR.light).toBeTruthy();
  });

  it('escapes vehicle labels, which ApexCharts writes into the legend and tooltip as HTML', () => {
    render(
      <ChargingPlanChart
        input={{
          slotStarts: slotStarts.slice(0, 1),
          plan: [{ departureId: 'vdp_1', powerKw: [10] }],
          capacityKw: [100],
          pricePerKwh: null,
        }}
        labelOf={() => '<img src=x onerror=alert(1)>'}
        timezone="UTC"
        nowMs={NOW}
      />,
    );
    expect(captured.series?.[0]?.name).toBe('&lt;img src=x onerror=alert(1)&gt;');
    const host = document.createElement('div');
    host.innerHTML = captured.series?.[0]?.name ?? '';
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('says there is no planned charging when no slot falls in the next 24 hours', () => {
    render(
      <ChargingPlanChart
        input={{ slotStarts: [], plan: [], capacityKw: null, pricePerKwh: null }}
        labelOf={() => ''}
        timezone="UTC"
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId('plan-chart-empty')).toBeTruthy();
    expect(screen.queryByTestId('apex')).toBeNull();
  });
});
