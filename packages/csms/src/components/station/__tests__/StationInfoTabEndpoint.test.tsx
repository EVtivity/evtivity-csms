// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  perms: new Set<string>(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));
vi.mock('../StationAiInsightsRow', () => ({ StationAiInsightsRow: () => null }));

import { StationInfoTab } from '../StationInfoTab';

const STATION = {
  id: 'st1',
  stationId: 'CS-1',
  siteId: null,
  vendorName: 'ABL',
  model: 'EM4-MASTER',
  serialNumber: 'SN-0001',
  firmwareVersion: '2.4.1',
  iccid: '8901260000000000001',
  imsi: null,
  availability: 'available',
  onboardingStatus: 'accepted',
  status: 'available',
  isOnline: false,
  isSimulator: false,
  lastHeartbeat: null,
  ocppProtocol: 'ocpp2.1',
  securityProfile: 1,
  hasPassword: true,
  latitude: null,
  longitude: null,
  reservationsEnabled: true,
  siteHoursOfOperation: null,
  siteFreeVendEnabled: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  aiInsightsSuppressedAt: null,
  aiInsightsSuppressedUntil: null,
  aiInsightsSuppressedReason: null,
  aiInsightsSuppressedBy: null,
  aiInsightsSuppressedSource: null,
};

let client: QueryClient;

function renderTab(simEnabled: boolean, station: Record<string, unknown> = STATION): void {
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/images') ? [] : { data: [], total: 0 }),
  );
  apiMock.patch.mockResolvedValue(STATION);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StationInfoTab
          station={station as never}
          stationId="st1"
          siteTimezone="UTC"
          simEnabled={simEnabled}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationInfoTab OCPP endpoint fields', () => {
  it('shows model, serial number and firmware as plain fields for a station without units', () => {
    renderTab(false, { ...STATION, unitCount: 0 });
    expect(screen.queryByTestId('ocpp-endpoint-group')).toBeNull();
    expect(screen.queryByText('stationUnits.ocppEndpoint')).toBeNull();
    expect(screen.getByText('stations.model')).toBeTruthy();
    expect(screen.getByText('ABL')).toBeTruthy();
    expect(screen.getByText('EM4-MASTER')).toBeTruthy();
    expect(screen.getByText('SN-0001')).toBeTruthy();
    expect(screen.getByText('2.4.1')).toBeTruthy();
  });

  it('groups them under OCPP Endpoint with the helper line for a station with units', () => {
    renderTab(false, { ...STATION, unitCount: 8 });
    const group = screen.getByRole('region', { name: 'stationUnits.ocppEndpoint' });
    expect(within(group).getByText('stationUnits.ocppEndpointHelp')).toBeTruthy();
    expect(within(group).getByText('stations.vendor')).toBeTruthy();
    expect(within(group).getByText('ABL')).toBeTruthy();
    expect(screen.getAllByText('stations.vendor')).toHaveLength(1);
    expect(within(group).getByText('stations.model')).toBeTruthy();
    expect(within(group).getByText('EM4-MASTER')).toBeTruthy();
    expect(within(group).getByText('stations.serialNumber')).toBeTruthy();
    expect(within(group).getByText('SN-0001')).toBeTruthy();
    expect(within(group).getByText('stations.firmware')).toBeTruthy();
    expect(within(group).getByText('2.4.1')).toBeTruthy();
    expect(screen.getAllByText('stations.model')).toHaveLength(1);
  });
});
