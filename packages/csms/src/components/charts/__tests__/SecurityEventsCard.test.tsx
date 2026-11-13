// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Security Events card: the donut of every severity, the station rows as
// served (critical rows red), the link to the station Security tab, the
// filters in the request, escaped chart labels, the empty note and the station list pages.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ApexOptions } from 'apexcharts';

const captured = vi.hoisted((): { options: ApexOptions | null; series: unknown } => ({
  options: null,
  series: null,
}));
const state = vi.hoisted(
  (): {
    reply: unknown;
    requested: string[];
    permissions: Set<string>;
    translate: (key: string) => string;
  } => ({
    reply: null,
    requested: [] as string[],
    permissions: new Set<string>(['securityEvents:read', 'sites:read']),
    translate: (key: string) => key,
  }),
);

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
      opts == null ? state.translate(key) : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { theme: string; timezone: string }) => unknown) =>
    selector({ theme: 'light', timezone: 'UTC' }),
  useHasPermission: (p: string) => state.permissions.has(p),
}));

vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => `at ${value}`,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => {
      state.requested.push(path);
      if (path.startsWith('/v1/sites')) {
        return Promise.resolve({
          data: [
            { id: 'sit_a', name: 'North' },
            { id: 'sit_b', name: 'South' },
          ],
          total: 2,
        });
      }
      return Promise.resolve(state.reply);
    },
  },
}));

import { SecurityEventsCard, securityEventsPath } from '../SecurityEventsCard';

const reply = {
  range: '7d',
  since: '2026-11-03T00:00:00.000Z',
  counts: { critical: 1, high: 2, medium: 0, low: 0, info: 4 },
  total: 7,
  stations: [
    {
      id: 'sta_1',
      stationId: '<img src=x onerror=alert(1)>',
      siteId: 'sit_a',
      siteName: '<b>North</b>',
      worstSeverity: 'critical',
      counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      total: 1,
      lastEventAt: '2026-11-09T10:00:00.000Z',
    },
    {
      id: 'sta_2',
      stationId: 'CS-2',
      siteId: 'sit_b',
      siteName: 'South',
      worstSeverity: 'high',
      counts: { critical: 0, high: 2, medium: 0, low: 0, info: 4 },
      total: 6,
      lastEventAt: '2026-11-08T10:00:00.000Z',
    },
  ],
  stationTotal: 2,
};

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SecurityEventsCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  captured.options = null;
  captured.series = null;
  state.reply = null;
  state.requested.length = 0;
  state.permissions = new Set(['securityEvents:read', 'sites:read']);
  state.translate = (key: string) => key;
});

describe('SecurityEventsCard', () => {
  it('builds the request path from the filters', () => {
    expect(securityEventsPath('7d', '', '')).toBe(
      '/v1/dashboard/security-events?range=7d&page=1&limit=20',
    );
    expect(securityEventsPath('24h', 'sit_a', 'critical', 3)).toBe(
      '/v1/dashboard/security-events?range=24h&siteId=sit_a&severity=critical&page=3&limit=20',
    );
  });

  it('draws every severity in the donut and the stations in the served order', async () => {
    state.reply = reply;
    renderCard();
    const rows = await screen.findAllByTestId('security-events-row');
    expect(rows.map((r) => r.getAttribute('data-severity'))).toEqual(['critical', 'high']);
    expect(captured.series).toEqual([1, 2, 0, 0, 4]);
    expect(captured.options?.labels).toEqual([
      'severity.critical',
      'severity.high',
      'severity.medium',
      'severity.low',
      'severity.info',
    ]);
  });

  it('marks critical rows red, for screen readers too, and links to the Security tab', async () => {
    state.reply = reply;
    renderCard();
    const rows = await screen.findAllByTestId('security-events-row');
    const critical = rows[0] as HTMLElement;
    expect(critical.className).toContain('bg-destructive/10');
    expect(critical.className).toContain('border-l-destructive');
    expect(within(critical).getByText(', dashboard.securityEvents.criticalRow')).toBeTruthy();
    expect((rows[1] as HTMLElement).className).not.toContain('bg-destructive');
    const link = within(critical).getByRole('link');
    expect(link.getAttribute('href')).toBe('/stations/sta_1?tab=security');
  });

  it('shows a station id and site name as text, never as markup', async () => {
    state.reply = reply;
    renderCard();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<b>North</b>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('escapes the severity labels it gives ApexCharts', async () => {
    state.translate = (key: string) => (key === 'severity.critical' ? '<i>Crit</i>' : key);
    state.reply = reply;
    renderCard();
    await screen.findAllByTestId('security-events-row');
    expect(captured.options?.labels?.[0]).toBe('&lt;i&gt;Crit&lt;/i&gt;');
  });

  it('sends the range, site and severity filters', async () => {
    state.reply = reply;
    renderCard();
    await screen.findAllByTestId('security-events-row');
    fireEvent.change(screen.getByLabelText('dashboard.securityEvents.range'), {
      target: { value: '30d' },
    });
    await waitFor(() => {
      expect(state.requested).toContain('/v1/dashboard/security-events?range=30d&page=1&limit=20');
    });
    const site = await screen.findByLabelText('dashboard.securityEvents.site');
    fireEvent.change(site, { target: { value: 'sit_b' } });
    fireEvent.change(screen.getByLabelText('dashboard.securityEvents.severity'), {
      target: { value: 'high' },
    });
    await waitFor(() => {
      expect(state.requested).toContain(
        '/v1/dashboard/security-events?range=30d&siteId=sit_b&severity=high&page=1&limit=20',
      );
    });
  });

  it('offers no site filter without sites:read', async () => {
    state.permissions = new Set(['securityEvents:read']);
    state.reply = reply;
    renderCard();
    await screen.findAllByTestId('security-events-row');
    expect(screen.queryByLabelText('dashboard.securityEvents.site')).toBeNull();
    expect(state.requested.some((p) => p.startsWith('/v1/sites'))).toBe(false);
  });

  it('shows the empty text without events', async () => {
    state.reply = {
      ...reply,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      total: 0,
      stations: [],
      stationTotal: 0,
    };
    renderCard();
    expect(await screen.findByText('dashboard.securityEvents.empty')).toBeTruthy();
    // An empty ring at the donut height, so the card keeps its size.
    expect(screen.getByTestId('empty-donut')).toBeTruthy();
    expect(screen.getByTestId('chart-placeholder').style.minHeight).toBe('280px');
  });

  it('shows no page controls for one page', async () => {
    state.reply = reply;
    renderCard();
    await screen.findAllByTestId('security-events-row');
    expect(screen.queryByText('common.next')).toBeNull();
  });

  it('pages the station list and starts again at page 1 on a new filter', async () => {
    state.reply = { ...reply, stationTotal: 75 };
    renderCard();
    expect(await screen.findByText('common.pageOf {"page":1,"totalPages":4}')).toBeTruthy();
    fireEvent.click(screen.getByText('common.next'));
    await waitFor(() => {
      expect(state.requested).toContain('/v1/dashboard/security-events?range=7d&page=2&limit=20');
    });
    expect(await screen.findByText('common.pageOf {"page":2,"totalPages":4}')).toBeTruthy();
    // The donut keeps the counts of the whole range on every page.
    expect(captured.series).toEqual([1, 2, 0, 0, 4]);
    fireEvent.change(screen.getByLabelText('dashboard.securityEvents.severity'), {
      target: { value: 'high' },
    });
    await waitFor(() => {
      expect(state.requested).toContain(
        '/v1/dashboard/security-events?range=7d&severity=high&page=1&limit=20',
      );
    });
  });

  it('steps back to the last page when the list shrinks', async () => {
    state.reply = { ...reply, stationTotal: 45 };
    renderCard();
    await screen.findByText('common.pageOf {"page":1,"totalPages":3}');
    fireEvent.click(screen.getByText('common.next'));
    await screen.findByText('common.pageOf {"page":2,"totalPages":3}');
    // Rows aged out of the range: page 3 answers a total of two pages.
    state.reply = { ...reply, stationTotal: 21 };
    fireEvent.click(screen.getByText('common.next'));
    await waitFor(() => {
      expect(state.requested).toContain('/v1/dashboard/security-events?range=7d&page=3&limit=20');
    });
    // Back on page 2 (its cached reply still counts three pages).
    expect(await screen.findByText(/^common\.pageOf \{"page":2,/)).toBeTruthy();
  });
});
