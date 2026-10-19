// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
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
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
  ApiError: class extends Error {},
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import {
  StationChargingNeedsTab,
  formatLimit,
  requestedEnergyWh,
} from '../StationChargingNeedsTab';

const NOW = '2026-10-13T10:00:00.000Z';

function mockData(): void {
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/ev-charging-needs')) {
      return Promise.resolve([
        {
          id: 1,
          evseId: 1,
          chargingNeeds: { acChargingParameters: { energyAmount: 5000 } },
          departureTime: null,
          requestedEnergyTransfer: 'AC_three_phase',
          controlMode: 'ScheduledControl',
          csmsChargingProfile: {
            payload: {
              chargingProfile: {
                chargingSchedule: [
                  {
                    chargingRateUnit: 'W',
                    chargingSchedulePeriod: [{ startPeriod: 0, limit: 11040 }],
                  },
                ],
              },
            },
            renegotiations: 0,
          },
          updatedAt: NOW,
        },
      ]);
    }
    if (url.includes('/ev-charging-schedules')) {
      return Promise.resolve({
        data: [
          {
            id: 2,
            evseId: 1,
            timeBase: NOW,
            chargingSchedule: {
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 22000 }],
            },
            withinLimits: false,
            createdAt: NOW,
          },
        ],
        total: 1,
      });
    }
    return Promise.resolve({
      data: [
        {
          id: 3,
          monitoringId: 42,
          component: 'EVSE',
          variable: 'Power',
          type: 'UpperThreshold',
          value: '7000',
          severity: 2,
          status: 'active',
          errorInfo: null,
          createdAt: NOW,
        },
      ],
      total: 1,
    });
  });
}

function renderTab(isOnline = true, ocppProtocol: string | null = null): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationChargingNeedsTab
        stationId="sta_1"
        isOnline={isOnline}
        timezone="UTC"
        ocppProtocol={ocppProtocol}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permission.canWrite = true;
});

describe('StationChargingNeedsTab helpers', () => {
  it('reads the requested energy of ISO 15118-2 and -20 needs', () => {
    expect(requestedEnergyWh({ dcChargingParameters: { energyAmount: 20000 } })).toBe(20000);
    expect(requestedEnergyWh({ v2xChargingParameters: { evTargetEnergyRequest: 8000 } })).toBe(
      8000,
    );
    expect(requestedEnergyWh({})).toBeNull();
  });

  it('shows W limits in kW and A limits in A', () => {
    expect(formatLimit(11040, 'W')).toMatch(/11[.,]04 kW/);
    expect(formatLimit(16, 'A')).toBe('16 A');
  });
});

describe('StationChargingNeedsTab', () => {
  it('shows the needs with the CSMS limit, the schedule check and the monitors', async () => {
    mockData();
    renderTab();
    expect(await screen.findByText('AC_three_phase')).toBeTruthy();
    expect(screen.getByText(/11[.,]04 kW/)).toBeTruthy();
    expect(await screen.findByText('stationChargingNeeds.exceedsLimits')).toBeTruthy();
    expect(await screen.findByText('stationChargingNeeds.status.active')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('hides the monitor actions without write permission', async () => {
    permission.canWrite = false;
    mockData();
    renderTab();
    await screen.findByText('stationChargingNeeds.status.active');
    expect(screen.queryByText('stationChargingNeeds.addMonitor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'stationChargingNeeds.clearMonitor' })).toBeNull();
  });

  it('disables the 2.1-only monitor types for an OCPP 2.0.1 station', async () => {
    mockData();
    renderTab(true, 'ocpp2.0.1');
    fireEvent.click(await screen.findByText('stationChargingNeeds.addMonitor'));
    const select = screen.getByLabelText('stationChargingNeeds.monitorType');
    const option = (value: string): HTMLOptionElement | null =>
      select.querySelector(`option[value="${value}"]`);

    expect(option('TargetDelta')?.disabled).toBe(true);
    expect(option('TargetDelta')?.title).toBe('stations.notAvailableOcpp201');
    expect(option('TargetDeltaRelative')?.disabled).toBe(true);
    expect(option('Delta')?.disabled).toBe(false);
  });

  it('offers every monitor type to an OCPP 2.1 station', async () => {
    mockData();
    renderTab(true, 'ocpp2.1');
    fireEvent.click(await screen.findByText('stationChargingNeeds.addMonitor'));
    const select = screen.getByLabelText('stationChargingNeeds.monitorType');

    expect(select.querySelectorAll('option:disabled')).toHaveLength(0);
  });

  it('refuses a Delta monitor with a value of 0 before sending', async () => {
    mockData();
    renderTab();
    fireEvent.click(await screen.findByText('stationChargingNeeds.addMonitor'));
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.component'), {
      target: { value: 'EVSE' },
    });
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.variable'), {
      target: { value: 'Power' },
    });
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.monitorType'), {
      target: { value: 'Delta' },
    });
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.value'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    expect(await screen.findByText('stationChargingNeeds.valueMustBePositive')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('creates a monitor with the entered values', async () => {
    mockData();
    postMock.mockResolvedValue({});
    renderTab();
    fireEvent.click(await screen.findByText('stationChargingNeeds.addMonitor'));
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.component'), {
      target: { value: 'EVSE' },
    });
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.variable'), {
      target: { value: 'Power' },
    });
    fireEvent.change(screen.getByLabelText('stationChargingNeeds.value'), {
      target: { value: '7000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/monitoring-rules', {
        component: 'EVSE',
        variable: 'Power',
        type: 'UpperThreshold',
        value: 7000,
        severity: 0,
      });
    });
  });

  it('disables adding a monitor while the station is offline', async () => {
    mockData();
    renderTab(false);
    const button = await screen.findByRole('button', { name: /stationChargingNeeds.addMonitor/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
