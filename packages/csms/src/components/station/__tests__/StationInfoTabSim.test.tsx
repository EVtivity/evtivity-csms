// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));
vi.mock('../StationAiInsightsRow', () => ({ StationAiInsightsRow: () => null }));

import { StationInfoTab } from '../StationInfoTab';

const STATION = {
  id: 'st1',
  stationId: 'CS-1',
  siteId: null,
  vendorName: null,
  model: 'M1',
  serialNumber: null,
  firmwareVersion: null,
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
  perms.add('stations:write');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationInfoTab ICCID and IMSI', () => {
  it('shows neither while both SIM switches are off, and saves without them', async () => {
    renderTab(false);
    expect(screen.queryByText('stations.iccid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    expect(screen.queryByLabelText('stations.iccid')).toBeNull();
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    const body = apiMock.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('iccid' in body).toBe(false);
    expect('imsi' in body).toBe(false);
  });

  it('shows both when a SIM feature is on', () => {
    renderTab(true);
    expect(screen.getByText('stations.iccid')).toBeTruthy();
    expect(screen.getByText('8901260000000000001')).toBeTruthy();
    expect(screen.getByText('stations.imsi')).toBeTruthy();
  });

  it('edits them only with stations:write', () => {
    perms.delete('stations:write');
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    expect(screen.queryByLabelText('stations.iccid')).toBeNull();
  });

  it('refuses an ICCID that is not 19 or 20 digits and an IMSI over 15 digits', async () => {
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.change(screen.getByLabelText('stations.iccid'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('stations.imsi'), {
      target: { value: '1234567890123456' },
    });
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    expect(await screen.findByText('stations.sim.iccidInvalid')).toBeTruthy();
    expect(screen.getByText('stations.sim.imsiInvalid')).toBeTruthy();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('sends a changed ICCID with its trailing F, an IMSI, and null for a cleared ICCID', async () => {
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.change(screen.getByLabelText('stations.iccid'), {
      target: { value: '8901260000000000002F' },
    });
    fireEvent.change(screen.getByLabelText('stations.imsi'), { target: { value: '310150123' } });
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.patch.mock.calls[0]?.[1]).toMatchObject({
      iccid: '8901260000000000002F',
      imsi: '310150123',
    });
    cleanup();
    vi.clearAllMocks();
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.change(screen.getByLabelText('stations.iccid'), { target: { value: '' } });
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    const body = apiMock.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.iccid).toBeNull();
    expect('imsi' in body).toBe(false);
  });

  it('accepts an ICCID with spaces around it and sends it trimmed', async () => {
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.change(screen.getByLabelText('stations.iccid'), {
      target: { value: '  8901260000000000002F ' },
    });
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('stations.sim.iccidInvalid')).toBeNull();
    expect(apiMock.patch.mock.calls[0]?.[1]).toMatchObject({ iccid: '8901260000000000002F' });
  });

  it('leaves an unchanged ICCID out of the save', async () => {
    renderTab(true);
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect('iccid' in (apiMock.patch.mock.calls[0]?.[1] as Record<string, unknown>)).toBe(false);
  });

  it('shows n/a for a missing ICCID or IMSI', () => {
    renderTab(true, { ...STATION, iccid: null, imsi: null });
    expect(screen.getAllByText('common.na')).toHaveLength(2);
  });

  it('reloads the SIM status after a changed ICCID or IMSI, and only then', async () => {
    renderTab(true);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.change(screen.getByLabelText('stations.imsi'), { target: { value: '310150123' } });
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['station-sim', 'st1'] });
    });
    cleanup();
    vi.clearAllMocks();
    renderTab(true);
    const unchanged = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: /common.edit/ }));
    fireEvent.submit(screen.getByLabelText('stations.model').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(unchanged).toHaveBeenCalledWith({ queryKey: ['stations'] });
    });
    expect(unchanged).not.toHaveBeenCalledWith({ queryKey: ['station-sim', 'st1'] });
  });
});
