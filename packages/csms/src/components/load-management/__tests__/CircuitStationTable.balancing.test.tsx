// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { CircuitStationTable, type CircuitStationStatus } from '../CircuitStationTable';

const STATION: CircuitStationStatus = {
  id: 'sta_one',
  stationId: 'CS-ONE',
  currentDrawKw: 0,
  allocatedLimitKw: 11,
  maxPowerKw: 22,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: false,
  balancingMode: 'station',
  evseLimitsRefusedAt: null,
};

function renderTable(station: CircuitStationStatus, canWrite: boolean): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CircuitStationTable
        siteId="sit_one"
        stations={[station]}
        strategy="equal_share"
        canWrite={canWrite}
        onRemove={() => undefined}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CircuitStationTable balancing mode', () => {
  it('saves the per-EVSE mode through the balancing mode route', async () => {
    apiMock.patch.mockResolvedValue({});
    renderTable(STATION, true);
    const select = screen.getByLabelText<HTMLSelectElement>(
      'loadManagement.balancingModeFor:{"stationId":"CS-ONE"}',
    );
    expect(select.value).toBe('station');
    fireEvent.change(select, { target: { value: 'evse' } });
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        '/v1/sites/sit_one/stations/sta_one/load-balancing-mode',
        { mode: 'evse' },
      );
    });
  });

  it('shows the mode as text without loadManagement:write', () => {
    renderTable({ ...STATION, balancingMode: 'evse' }, false);
    const cell = screen.getByTestId('circuit-station-balancing');
    expect(within(cell).queryByRole('combobox')).toBeNull();
    expect(cell.textContent).toContain('loadManagement.balancingModeEvse');
  });

  it('treats a station without a stored mode as station balancing', () => {
    const withoutMode: CircuitStationStatus = { ...STATION };
    delete withoutMode.balancingMode;
    renderTable(withoutMode, true);
    const select = screen.getByLabelText<HTMLSelectElement>(
      'loadManagement.balancingModeFor:{"stationId":"CS-ONE"}',
    );
    expect(select.value).toBe('station');
  });

  it('warns when the station refused per-EVSE limits', () => {
    renderTable(
      { ...STATION, balancingMode: 'evse', evseLimitsRefusedAt: '2026-11-24T10:00:00Z' },
      true,
    );
    const badge = screen.getByTestId('circuit-station-evse-refused');
    expect(badge.textContent).toBe('loadManagement.evseLimitsRefused');
    expect(badge.getAttribute('title')).toBe('loadManagement.evseLimitsRefusedNote');
  });

  it('shows no refusal badge for a station that takes per-EVSE limits', () => {
    renderTable({ ...STATION, balancingMode: 'evse' }, true);
    expect(screen.queryByTestId('circuit-station-evse-refused')).toBeNull();
  });

  it('shows the save error of a refused mode change', async () => {
    apiMock.patch.mockRejectedValue(new Error('Station not found'));
    renderTable(STATION, true);
    fireEvent.change(
      screen.getByLabelText('loadManagement.balancingModeFor:{"stationId":"CS-ONE"}'),
      { target: { value: 'evse' } },
    );
    expect(await screen.findByText('Station not found')).toBeTruthy();
  });
});
