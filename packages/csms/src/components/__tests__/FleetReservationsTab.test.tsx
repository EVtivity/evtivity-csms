// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, deleteMock, toastMock, permission } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: postMock, delete: deleteMock }, ApiError };
});

vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

// The slot row's station and driver pickers query the API; a button that
// picks a fixed station stands in for them.
vi.mock('@/components/fleet/BulkReservationSlotRow', () => ({
  emptyBulkReservationSlot: () => ({ station: null, connectorKey: '', driver: null }),
  parseSlotEvseId: () => null,
  BulkReservationSlotRow: ({
    slot,
    onChange,
  }: {
    slot: { station: unknown };
    onChange: (next: unknown) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onChange({ ...slot, station: { id: 'sta_1', stationId: 'CS-001' } });
      }}
    >
      pick-station
    </button>
  ),
}));

import { FleetReservationsTab, MAX_BULK_RESERVATION_SLOTS } from '../fleet/FleetReservationsTab';

const BOOKING = {
  id: 'frs_000000000001',
  fleetId: 'flt_000000000001',
  name: 'Morning Shift',
  status: 'active',
  startsAt: null,
  expiresAt: '2030-01-01T00:00:00Z',
  createdAt: '2029-12-31T00:00:00Z',
  updatedAt: '2029-12-31T00:00:00Z',
  reservationCount: 2,
};

function mockList(data: unknown[] | Error): void {
  getMock.mockImplementation((url: string) => {
    if (url.startsWith('/v1/portal/features')) return Promise.resolve({ reservationMaxHours: 0 });
    if (data instanceof Error) return Promise.reject(data);
    return Promise.resolve({ data, total: data.length });
  });
}

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FleetReservationsTab fleetId="flt_000000000001" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  permission.canWrite = true;
});

describe('FleetReservationsTab', () => {
  it('hides the create and cancel controls without reservations:write', async () => {
    permission.canWrite = false;
    mockList([BOOKING]);
    renderTab();
    await screen.findByText('Morning Shift');
    expect(screen.queryByText('fleets.newBulkReservation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.cancelFleetReservation' })).toBeNull();
  });

  it('shows the create and cancel controls with reservations:write', async () => {
    mockList([BOOKING]);
    renderTab();
    await screen.findByText('Morning Shift');
    expect(screen.getByText('fleets.newBulkReservation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'fleets.cancelFleetReservation' })).toBeTruthy();
  });

  it('shows an error row with a retry when the list fails to load', async () => {
    mockList(new Error('network'));
    renderTab();
    await screen.findByText('common.loadError');
    fireEvent.click(screen.getByText('common.retry'));
    await waitFor(() => {
      expect(
        getMock.mock.calls.filter((c) => String(c[0]).startsWith('/v1/fleets/')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('spans the empty row over every column', async () => {
    mockList([]);
    renderTab();
    const cell = await screen.findByText('reservations.noReservations');
    expect(cell.closest('td')?.getAttribute('colspan')).toBe('7');
  });

  it('lists each rejected slot with its reason after a partial create', async () => {
    mockList([]);
    postMock.mockResolvedValue({
      id: 'frs_000000000002',
      status: 'partial',
      confirmed: 1,
      failed: 1,
      total: 2,
      results: [
        {
          stationOcppId: 'CS-001',
          evseId: null,
          reservationId: 'rsv_1',
          status: 'confirmed',
          error: null,
        },
        {
          stationOcppId: 'CS-002',
          evseId: 2,
          reservationId: null,
          status: 'rejected',
          error: 'Station is offline',
        },
      ],
    });
    renderTab();
    await screen.findByText('reservations.noReservations');
    fireEvent.click(screen.getByText('fleets.newBulkReservation'));
    fireEvent.click(await screen.findByText('pick-station'));
    fireEvent.click(screen.getByText('common.create'));

    const list = await screen.findByTestId('bulk-reservation-rejected');
    expect(list.textContent).toContain('CS-002');
    expect(list.textContent).toContain('Station is offline');
    expect(list.textContent).not.toContain('CS-001');
    expect(postMock).toHaveBeenCalledWith(
      '/v1/fleets/flt_000000000001/reservations',
      expect.objectContaining({ slots: [{ stationOcppId: 'CS-001' }] }),
    );
  });

  it('stops adding stations at the slot limit the API accepts', async () => {
    mockList([]);
    renderTab();
    await screen.findByText('reservations.noReservations');
    fireEvent.click(screen.getByText('fleets.newBulkReservation'));
    const add = await screen.findByText('fleets.addStation');
    for (let i = 1; i < MAX_BULK_RESERVATION_SLOTS + 5; i++) fireEvent.click(add);
    expect(screen.getAllByText('pick-station')).toHaveLength(MAX_BULK_RESERVATION_SLOTS);
    expect(screen.getByText('fleets.maxSlotsReached')).toBeTruthy();
    expect((add.closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
