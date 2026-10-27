// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/components/station-combobox', () => ({ StationCombobox: () => <div /> }));
vi.mock('@/components/driver-combobox', () => ({ DriverCombobox: () => <div /> }));

import {
  BulkReservationSlotRow,
  type BulkReservationSlotState,
} from '../fleet/BulkReservationSlotRow';

const STATION = { id: 'sta_1', stationId: 'CS-001' } as BulkReservationSlotState['station'];

const EVSES = [
  {
    id: 'evse_1',
    evseId: 1,
    connectors: [{ id: 'c1', connectorId: 1, connectorType: 'CCS2', maxPowerKw: '150' }],
  },
  {
    id: 'evse_2',
    evseId: 2,
    connectors: [{ id: 'c2', connectorId: 1, connectorType: 'CCS2', maxPowerKw: null }],
  },
];

function renderRow(
  slot: BulkReservationSlotState,
  excludeConnectorKeys?: ReadonlySet<string>,
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BulkReservationSlotRow
        slot={slot}
        onChange={() => undefined}
        onRemove={null}
        excludeConnectorKeys={excludeConnectorKeys}
      />
    </QueryClientProvider>,
  );
}

function connectorSelect(): HTMLSelectElement {
  return screen.getByLabelText('reservations.connector');
}

beforeEach(() => {
  getMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('BulkReservationSlotRow', () => {
  it('asks for a station first', () => {
    renderRow({ station: null, connectorKey: '', driver: null });
    expect(connectorSelect().disabled).toBe(true);
    expect(connectorSelect().textContent).toBe('reservations.selectStationFirst');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('shows loading while the connectors load', () => {
    getMock.mockReturnValue(new Promise(() => undefined));
    renderRow({ station: STATION, connectorKey: '', driver: null });
    expect(connectorSelect().disabled).toBe(true);
    expect(connectorSelect().textContent).toBe('common.loading');
  });

  it('shows No Connectors for a station without connectors', async () => {
    getMock.mockResolvedValue([]);
    renderRow({ station: STATION, connectorKey: '', driver: null });
    await waitFor(() => {
      expect(connectorSelect().textContent).toBe('reservations.noConnectors');
    });
    expect(connectorSelect().disabled).toBe(true);
  });

  it('shows an error with Retry when the connectors fail to load', async () => {
    getMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(EVSES);
    renderRow({ station: STATION, connectorKey: '', driver: null });
    expect(await screen.findByText('common.loadError')).toBeTruthy();
    fireEvent.click(screen.getByText('common.retry'));
    await waitFor(() => {
      expect(connectorSelect().disabled).toBe(false);
    });
  });

  it('hides the connectors other slots picked at the station', async () => {
    getMock.mockResolvedValue(EVSES);
    renderRow({ station: STATION, connectorKey: '', driver: null }, new Set(['1-1']));
    await waitFor(() => {
      expect(connectorSelect().disabled).toBe(false);
    });
    const values = [...connectorSelect().options].map((o) => o.value);
    expect(values).toEqual(['', '2-1']);
  });
});
