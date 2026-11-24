// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ApexOptions } from 'apexcharts';

const captured: { options?: ApexOptions; series?: Array<{ name: string }> } = {};
const get = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ sessions: true }));

vi.mock('react-apexcharts', () => ({
  default: (props: { options: ApexOptions; series: Array<{ name: string }> }) => {
    captured.options = props.options;
    captured.series = props.series;
    return <div data-testid="apex" />;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values == null ? key : `${key}:${JSON.stringify(values)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: { theme: string }) => unknown) => select({ theme: 'light' }),
  useHasPermission: (perm: string) => (perm === 'sessions:read' ? perms.sessions : true),
}));
vi.mock('@/lib/api', () => ({ api: { get } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AllocationChart } from '../AllocationChart';
import { buildAllocationChartData, type AllocationSeriesItem } from '../allocation-chart-data';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');

function item(over: Partial<AllocationSeriesItem>): AllocationSeriesItem {
  return {
    key: 'station:sta_1',
    scope: 'station',
    stationId: 'sta_1',
    stationOcppId: 'CS-1',
    unitName: null,
    evseNumber: null,
    points: [
      { t: new Date(T0).toISOString(), limitKw: 22, reason: 'circuit_limit', reply: 'accepted' },
    ],
    ...over,
  };
}

function renderChart(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <AllocationChart siteId="sit_1" timezone="UTC" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.sessions = true;
  get.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/series')
        ? {
            series: [item({ stationOcppId: '<img src=x onerror=alert(1)>' })],
            references: { siteLimitKw: 50, panels: [], transformers: [] },
            truncated: false,
          }
        : {
            parts: [
              {
                sessionId: 'ses_1',
                stationId: 'sta_1',
                stationOcppId: 'CS-1',
                evseNumber: 2,
                unitName: 'Box 1',
                from: new Date(T0).toISOString(),
                to: null,
                tariffName: 'Night',
                maxCurrentA: 16,
              },
            ],
          },
    ),
  );
});

afterEach(() => {
  cleanup();
  delete captured.options;
  delete captured.series;
});

describe('buildAllocationChartData', () => {
  it('holds each step to the range end and folds the series past the palette into Other', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      item({
        key: `station:sta_${String(i)}`,
        stationOcppId: `CS-${String(i)}`,
        points: [
          {
            t: new Date(T0 + i * 60_000).toISOString(),
            limitKw: 10 + i,
            reason: 'station_share',
            reply: 'accepted',
          },
        ],
      }),
    );
    const end = T0 + 600_000;
    const series = buildAllocationChartData(items, end, (s) => s.stationOcppId, 'Other', 3);
    expect(series.map((s) => s.name)).toEqual(['CS-0', 'CS-1', 'Other']);
    expect(series[0]?.data).toEqual([
      { x: T0, y: 10 },
      { x: end, y: 10 },
    ]);
    expect(series[0]?.points[1]).toBeNull();
    // Other sums CS-2 (from T0+2min) and CS-3 (from T0+3min) as steps.
    expect(series[2]?.data).toEqual([
      { x: T0 + 120_000, y: 12 },
      { x: T0 + 180_000, y: 25 },
      { x: end, y: 25 },
    ]);
    expect(series[2]?.other).toBe(true);
  });
});

describe('AllocationChart', () => {
  it('escapes series names and draws the site limit and the session timeline', async () => {
    renderChart();
    await waitFor(() => {
      expect(captured.series?.[0]?.name).toBe('&lt;img src=x onerror=alert(1)&gt;');
    });
    expect(captured.options?.annotations?.yaxis?.[0]?.y).toBe(50);
    const formatter = captured.options?.tooltip?.y as
      | { formatter: (v: number, o: { seriesIndex: number; dataPointIndex: number }) => string }
      | undefined;
    expect(formatter?.formatter(22, { seriesIndex: 0, dataPointIndex: 0 })).toContain(
      'loadManagement.reasons.circuit_limit',
    );
    expect(formatter?.formatter(22, { seriesIndex: 0, dataPointIndex: 0 })).toContain(
      'loadManagement.replyStates.accepted',
    );
    const link = await screen.findByRole('link', { name: /CS-1 \/ Box 1/ });
    expect(link.getAttribute('href')).toBe('/sessions/ses_1');
    expect(screen.getByText('Night')).toBeTruthy();
    expect(get.mock.calls.some(([url]) => String(url).includes('/allocations/sessions?'))).toBe(
      true,
    );
  });

  it('reads no timeline without sessions:read', async () => {
    perms.sessions = false;
    renderChart();
    await waitFor(() => {
      expect(captured.series).toBeDefined();
    });
    expect(screen.queryByTestId('allocation-timeline')).toBeNull();
    expect(get.mock.calls.some(([url]) => String(url).includes('/allocations/sessions'))).toBe(
      false,
    );
  });

  it('shows the empty text when no limit was sent', async () => {
    get.mockImplementation(() =>
      Promise.resolve({
        series: [],
        references: { siteLimitKw: null, panels: [], transformers: [] },
        truncated: false,
        parts: [],
      }),
    );
    renderChart();
    expect(await screen.findByText('loadManagement.chart.empty')).toBeTruthy();
  });
});
