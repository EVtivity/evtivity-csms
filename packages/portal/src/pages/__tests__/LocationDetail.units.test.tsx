// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn(), delete: vi.fn() } };
});
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options == null ? key : `${key}:${Object.values(options).map(String).join('|')}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));
vi.mock('@/components/ImageCarousel', () => ({ ImageCarousel: () => null }));

import { LocationDetail } from '../LocationDetail';
import { groupLocationRows } from '@/components/LocationChargerRow';

function row(
  stationId: string,
  evseId: number,
  unit: { id: string; name: string } | null,
  available = true,
): Record<string, unknown> {
  return {
    stationId,
    stationName: stationId,
    evseId,
    unitId: unit?.id ?? null,
    unitName: unit?.name ?? null,
    connectorType: 'Type2',
    maxPowerKw: '22',
    status: 'available',
    available,
  };
}

const box1 = { id: 'unt_box1', name: 'Box 1' };
const box2 = { id: 'unt_box2', name: 'Box 2' };

// GitHub discussion 59: boxes of 2 AC EVSEs, and a plain station next to them.
const location = {
  siteId: 'sit_1',
  name: 'Parkhaus',
  address: null,
  city: null,
  state: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  hoursOfOperation: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  stationCount: 4,
  evseCount: 7,
  availableCount: 6,
  chargers: [
    row('CS-PLAIN', 1, null),
    row('CS-PLAIN', 2, null, false),
    row('EM4-MASTER-01', 1, box1),
    row('EM4-MASTER-01', 2, box1, false),
    row('EM4-MASTER-01', 3, box2),
    row('EM4-MASTER-01', 4, box2),
    row('EM4-MASTER-01', 5, null),
  ],
  driverChargers: [
    {
      stationId: 'CS-PLAIN',
      unitId: null,
      unitName: null,
      evseIds: [1, 2],
      evseCount: 2,
      availableCount: 1,
    },
    {
      stationId: 'EM4-MASTER-01',
      unitId: 'unt_box1',
      unitName: 'Box 1',
      evseIds: [1, 2],
      evseCount: 2,
      availableCount: 1,
    },
    {
      stationId: 'EM4-MASTER-01',
      unitId: 'unt_box2',
      unitName: 'Box 2',
      evseIds: [3, 4],
      evseCount: 2,
      availableCount: 2,
    },
    {
      stationId: 'EM4-MASTER-01',
      unitId: null,
      unitName: null,
      evseIds: [5],
      evseCount: 1,
      availableCount: 1,
    },
  ],
};

function Where(): React.JSX.Element {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderPage(body: Record<string, unknown>): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/popular-times?weeks=4') ? [] : body),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/location/sit_1']}>
        <Routes>
          <Route path="/location/:siteId" element={<LocationDetail />} />
          <Route path="/charge/*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('location page rows', () => {
  it('shows one row per charger: a station without units, each unit and the EVSEs without one', async () => {
    renderPage(location);
    const rows = await screen.findAllByTestId('location-charger-row');
    expect(rows.map((r) => within(r).getByTestId('charger-row-title').textContent)).toEqual([
      'CS-PLAIN',
      'Box 1',
      'Box 2',
      'EM4-MASTER-01',
    ]);
    const box1Row = rows[1] as HTMLElement;
    expect(within(box1Row).getByTestId('charger-row-station').textContent).toBe('EM4-MASTER-01');
    expect(within(box1Row).getAllByTestId('port-card')).toHaveLength(2);
    expect(within(box1Row).getByText('stationDetail.connectorPort:2')).toBeTruthy();
    expect(within(box1Row).getByText('location.available:1')).toBeTruthy();
    const href = (row: HTMLElement): string | null =>
      within(row).getByTestId('location-charger-link').getAttribute('href');
    expect(href(box1Row)).toBe('/charge/EM4-MASTER-01?unit=unt_box1');
    expect(href(rows[3] as HTMLElement)).toBe('/charge/EM4-MASTER-01');
  });

  it('gives a station without units the same row: its title, its ports and its link', async () => {
    renderPage(location);
    const plain = (await screen.findAllByTestId('location-charger-row'))[0] as HTMLElement;
    expect(within(plain).queryByTestId('charger-row-station')).toBeNull();
    expect(within(plain).getAllByTestId('port-card')).toHaveLength(2);
    expect(within(plain).getByTestId('location-charger-link').getAttribute('href')).toBe(
      '/charge/CS-PLAIN',
    );
    // The busy port opens nothing; the free one opens its EVSE.
    fireEvent.click(within(plain).getAllByTestId('port-card')[1] as HTMLElement);
    expect(screen.queryByTestId('where')).toBeNull();
    fireEvent.click(within(plain).getAllByTestId('port-card')[0] as HTMLElement);
    expect(screen.getByTestId('where').textContent).toBe('/charge/CS-PLAIN/1');
  });

  it('opens a free port of a unit row', async () => {
    renderPage(location);
    const rows = await screen.findAllByTestId('location-charger-row');
    fireEvent.click(within(rows[2] as HTMLElement).getAllByTestId('port-card')[1] as HTMLElement);
    expect(screen.getByTestId('where').textContent).toBe('/charge/EM4-MASTER-01/4');
  });

  it('groups the rows itself when the reply has no driver chargers', async () => {
    const older: Record<string, unknown> = { ...location };
    delete older['driverChargers'];
    renderPage(older);
    expect(await screen.findAllByTestId('location-charger-row')).toHaveLength(4);
  });
});

describe('groupLocationRows', () => {
  it('groups by station and unit in row order with the free EVSEs counted', () => {
    const groups = groupLocationRows(location.chargers as never);
    expect(groups.map((g) => [g.stationId, g.unitId, g.evseIds, g.availableCount])).toEqual([
      ['CS-PLAIN', null, [1, 2], 1],
      ['EM4-MASTER-01', 'unt_box1', [1, 2], 1],
      ['EM4-MASTER-01', 'unt_box2', [3, 4], 2],
      ['EM4-MASTER-01', null, [5], 1],
    ]);
  });
});
