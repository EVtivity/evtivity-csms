// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { ApiError } from '@/lib/api';
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

describe('StationInfoTab station hardware fields', () => {
  it.each([0, 8])(
    'shows vendor, model, serial number and firmware as plain fields with %i units',
    (unitCount) => {
      renderTab(false, { ...STATION, unitCount });
      expect(screen.queryByTestId('ocpp-endpoint-group')).toBeNull();
      expect(screen.queryByText('stationUnits.ocppEndpoint')).toBeNull();
      expect(screen.queryByText('stationUnits.ocppEndpointHelp')).toBeNull();
      for (const label of ['stations.vendor', 'stations.model', 'stations.serialNumber']) {
        expect(screen.getAllByText(label)).toHaveLength(1);
      }
      expect(screen.getByText('stations.firmware')).toBeTruthy();
      expect(screen.getByText('ABL')).toBeTruthy();
      expect(screen.getByText('EM4-MASTER')).toBeTruthy();
      expect(screen.getByText('SN-0001')).toBeTruthy();
      expect(screen.getByText('2.4.1')).toBeTruthy();
    },
  );
});

describe('StationInfoTab Uses Station Units switch', () => {
  it('sends the switch only when it changed, and shows the refusal of a station with units', async () => {
    perms.add('stations:write');
    renderTab(false, { ...STATION, usesUnits: true, unitCount: 8 });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    const toggle = screen.getByRole('switch', { name: 'stations.usesUnits' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.submit(toggle.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalled();
    });
    expect(apiMock.patch.mock.calls[0]?.[1]).not.toHaveProperty('usesUnits');

    apiMock.patch.mockReset();
    apiMock.patch.mockRejectedValue(
      new ApiError(409, { error: 'Delete the units first', code: 'STATION_UNITS_IN_USE' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    const again = screen.getByRole('switch', { name: 'stations.usesUnits' });
    fireEvent.click(again);
    fireEvent.submit(again.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        '/v1/stations/st1',
        expect.objectContaining({ usesUnits: false }),
      );
    });
    expect(await screen.findByText('Delete the units first')).toBeTruthy();
  });
});
