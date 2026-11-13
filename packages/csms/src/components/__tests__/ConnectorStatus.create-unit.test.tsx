// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, putMock, toastMock, canWrite } = vi.hoisted(() => ({
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastMock: vi.fn(),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: postMock, put: putMock, patch: vi.fn(), delete: vi.fn() },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => canWrite.value }));
vi.mock('@/lib/ocpp-command-access', () => ({ useCanSendOcppCommand: () => () => true }));

import { ConnectorStatus } from '../charts/ConnectorStatus';
import type { StationUnit } from '@/lib/station-units';

const EVSES = [
  {
    evseId: 1,
    status: 'available',
    unitId: null,
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: 11,
        maxCurrentAmps: 16,
        status: 'available',
        isIdling: false,
      },
    ],
  },
];

const UNITS: StationUnit[] = [
  {
    id: 'unt_b',
    stationId: 'sta_1',
    name: 'Box 2',
    sortOrder: 1,
    evseIds: [],
    evseNumbers: [],
  },
  {
    id: 'unt_a',
    stationId: 'sta_1',
    name: 'Box 1',
    sortOrder: 0,
    evseIds: [],
    evseNumbers: [],
  },
];

function renderTab(units: StationUnit[]): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={EVSES as never}
        stationId="sta_1"
        stationOcppId="CS-0001"
        ocppProtocol="ocpp2.1"
        isOnline
        isSimulator={false}
        units={units}
      />
    </QueryClientProvider>,
  );
}

function openAndFill(): HTMLFormElement {
  fireEvent.click(screen.getByRole('button', { name: 'stations.addEvse' }));
  const evseId = screen.getByLabelText('stations.evseIdLabel');
  fireEvent.change(evseId, { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('stations.maxPower'), { target: { value: '22' } });
  return evseId.closest('form') as HTMLFormElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite.value = true;
});

describe('Create EVSE unit field', () => {
  it('shows no unit field for a station without units', () => {
    renderTab([]);
    fireEvent.click(screen.getByRole('button', { name: 'stations.addEvse' }));
    expect(screen.queryByLabelText('stationUnits.unit')).toBeNull();
  });

  it('offers No Unit first, then the units in unit order', () => {
    renderTab(UNITS);
    fireEvent.click(screen.getByRole('button', { name: 'stations.addEvse' }));
    const select = screen.getByLabelText<HTMLSelectElement>('stationUnits.unit');
    expect(select.value).toBe('');
    expect(Array.from(select.options, (o) => o.text)).toEqual([
      'stationUnits.noUnit',
      'Box 1',
      'Box 2',
    ]);
  });

  it('hides the unit field without stations:write', () => {
    canWrite.value = false;
    renderTab(UNITS);
    fireEvent.click(screen.getByRole('button', { name: 'stations.addEvse' }));
    expect(screen.queryByLabelText('stationUnits.unit')).toBeNull();
  });

  it('creates the EVSE without a unit call when No Unit stays picked', async () => {
    postMock.mockResolvedValue({});
    renderTab(UNITS);
    fireEvent.submit(openAndFill());
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('sets the picked unit after the EVSE is created', async () => {
    postMock.mockResolvedValue({});
    putMock.mockResolvedValue({});
    renderTab(UNITS);
    const form = openAndFill();
    fireEvent.change(screen.getByLabelText('stationUnits.unit'), { target: { value: 'unt_b' } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/2/unit', {
        unitId: 'unt_b',
      });
    });
    expect(postMock).toHaveBeenCalledWith(
      '/v1/stations/sta_1/evses',
      expect.objectContaining({ evseId: 2 }),
    );
    expect(postMock.mock.invocationCallOrder[0]).toBeLessThan(
      putMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('keeps the EVSE and says it has no unit when the unit call fails', async () => {
    postMock.mockResolvedValue({});
    putMock.mockRejectedValue(new Error('refused'));
    renderTab(UNITS);
    const form = openAndFill();
    fireEvent.change(screen.getByLabelText('stationUnits.unit'), { target: { value: 'unt_a' } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'stationUnits.evseCreatedWithoutUnit',
        }),
      );
    });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('sets no unit when the EVSE create fails', async () => {
    postMock.mockRejectedValue(new Error('duplicate'));
    renderTab(UNITS);
    const form = openAndFill();
    fireEvent.change(screen.getByLabelText('stationUnits.unit'), { target: { value: 'unt_a' } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    expect(putMock).not.toHaveBeenCalled();
  });
});
