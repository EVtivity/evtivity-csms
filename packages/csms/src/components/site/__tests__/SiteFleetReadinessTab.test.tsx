// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, putMock, toastMock, perms } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastMock: vi.fn(),
  perms: new Set<string>(['loadManagement:write', 'sessions:write', 'drivers:read']),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null
        ? key
        : `${key}:${Object.entries(opts)
            .filter(([k]) => k !== 'defaultValue')
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')}`,
    i18n: { language: 'en' },
  }),
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
  return { api: { get: getMock, post: postMock, put: putMock }, ApiError };
});
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasCompanyWidePermission: (p: string) => perms.has(p),
  useAuth: (select: (s: { theme: string; timezone: string }) => unknown) =>
    select({ theme: 'light', timezone: 'UTC' }),
}));
vi.mock('@/lib/timezone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/timezone')>()),
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('../ChargingPlanChart', () => ({
  ChargingPlanChart: () => <div data-testid="charging-plan-chart" />,
}));

import { SiteFleetReadinessTab, type SiteChargingPlan } from '../SiteFleetReadinessTab';

const departure = {
  id: 'vdp_1',
  vehicleId: 'veh_1',
  siteId: 'sit_1',
  siteName: 'Northgate Depot',
  vehicle: {
    id: 'veh_1',
    driverId: 'drv_1',
    make: 'BYD',
    model: 'K9',
    licensePlate: 'BUS-12',
    bodyType: 'bus',
  },
  station: { id: 'sta_1', stationId: 'CS-DEPOT-1', evseId: 1 },
  scheduleId: null,
  departureAt: '2026-11-03T13:30:00.000Z',
  targetKind: 'energy' as const,
  targetEnergyKwh: 120,
  targetSocPercent: null,
  priority: 5,
  source: 'manual',
  overridden: false,
  status: 'scheduled' as const,
  readiness: 'cannot_meet' as const,
  readinessReason: 'site_capacity' as const,
  sessionId: 'ses_1',
  plannedKwh: 88,
  deliveredKwh: 45,
  shortfallKwh: 32,
  predictedReadyAt: null,
};

function plan(overrides: Partial<SiteChargingPlan> = {}): SiteChargingPlan {
  return {
    planning: true,
    notPlanningReason: null,
    bufferMinutes: 30,
    computedAt: '2026-11-03T10:00:00.000Z',
    staleAt: null,
    slotStarts: ['2026-11-03T10:00:00.000Z'],
    plan: [],
    capacityKw: [300],
    pricePerKwh: [0.2],
    departures: [departure],
    unidentifiedSessions: [
      {
        sessionId: 'ses_9',
        stationId: 'sta_2',
        stationOcppId: 'CS-DEPOT-2',
        evseId: 1,
        driverId: 'drv_9',
        startedAt: '2026-11-03T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function wrap(view: SiteChargingPlan): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/sites/sit_1/charging-plan') return Promise.resolve(view);
    if (url === '/v1/drivers/drv_9/vehicles') {
      return Promise.resolve([
        { id: 'veh_9', make: 'Ford', model: 'E-Transit', licensePlate: 'VAN-9' },
      ]);
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SiteFleetReadinessTab siteId="sit_1" timezone="America/Los_Angeles" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  perms.clear();
  for (const p of ['loadManagement:write', 'sessions:write', 'drivers:read']) perms.add(p);
});

describe('SiteFleetReadinessTab', () => {
  it('switches to the cancelled departures and shows their reasons without readiness', async () => {
    wrap(plan());
    await screen.findByTestId('readiness-row-vdp_1');
    const cancelled = {
      ...departure,
      id: 'vdp_x',
      status: 'cancelled' as const,
      readiness: null,
      readinessReason: null,
      cancelReason: 'superseded_by_depot_system' as const,
    };
    const byPerson = { ...cancelled, id: 'vdp_y', cancelReason: null, source: 'schedule' };
    getMock.mockImplementation((url: string) => {
      if (url === '/v1/sites/sit_1/charging-plan?departureStatus=cancelled') {
        return Promise.resolve(
          plan({ departureStatus: 'cancelled', departures: [cancelled, byPerson] }),
        );
      }
      if (url === '/v1/sites/sit_1/charging-plan') return Promise.resolve(plan());
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const toggle = screen.getByRole('button', { name: 'fleets.departures.statuses.cancelled' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    const row = await screen.findByTestId('readiness-row-vdp_x');
    expect(getMock).toHaveBeenCalledWith('/v1/sites/sit_1/charging-plan?departureStatus=cancelled');
    expect(
      screen
        .getByRole('button', { name: 'fleets.departures.statuses.cancelled' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(row).getByTestId('readiness-reason-vdp_x').textContent).toBe(
      'fleets.departures.cancelReasons.superseded_by_depot_system',
    );
    expect(within(row).getByText('fleets.departures.statuses.cancelled')).toBeTruthy();
    expect(within(row).getByTestId('departure-source-badge').textContent).toBe(
      'fleets.departures.sources.manual',
    );
    const other = screen.getByTestId('readiness-row-vdp_y');
    expect(within(other).getByTestId('readiness-reason-vdp_y').textContent).toBe(
      'fleets.departures.cancelledByPerson',
    );
    expect(within(other).getByText('fleets.departures.sources.schedule')).toBeTruthy();
    // No readiness summary for cancelled departures.
    expect(screen.queryByTestId('fleet-readiness-summary')).toBeNull();
  });

  it('shows an ad hoc bus depot request as soon as possible, with its requested point', async () => {
    const adHoc = {
      ...departure,
      id: 'vdp_7',
      departureAt: null,
      adHoc: true,
      station: null,
      targetKind: 'soc' as const,
      targetEnergyKwh: null,
      targetSocPercent: 70,
      targetSocMaxPercent: 95,
      requestedEvseId: 'evs_7',
      requestedChargingPointId: 'VDV-CS-01/2',
      source: 'depot_system',
      depotSystemId: 'dms_1',
      predictedMaxReadyAt: '2026-11-03T14:00:00.000Z',
      predictedReadyAt: '2026-11-03T13:00:00.000Z',
      readiness: 'on_track' as const,
    };
    wrap(plan({ departures: [adHoc, departure] }));
    const row = await screen.findByTestId('readiness-row-vdp_7');
    expect(within(row).getByText('fleets.departures.asSoonAsPossible')).toBeTruthy();
    expect(within(row).getByText('fleets.departures.targetUpTo:target=70%,max=95%')).toBeTruthy();
    expect(within(row).getByTestId('readiness-requested-vdp_7').textContent).toContain(
      'VDV-CS-01/2',
    );
    expect(within(row).getByTestId('depot-system-badge')).toBeTruthy();
    // 14:00 UTC is 6:00 in Los Angeles.
    expect(within(row).getByText(/predictedMaxReady:time=6:00/)).toBeTruthy();
  });

  it('shows the summary, the readiness, the chart and Recalculate while planning is on', async () => {
    wrap(plan());
    const row = await screen.findByTestId('readiness-row-vdp_1');
    expect(within(row).getByText('fleets.departures.readiness.cannot_meet')).toBeTruthy();
    expect(within(row).getByText('fleets.departures.reasons.site_capacity')).toBeTruthy();
    expect(within(row).getByText('vehicles.bodyTypes.bus')).toBeTruthy();
    expect(
      within(row).getByText('sites.fleetReadiness.stationWithEvse:station=CS-DEPOT-1,evse=1'),
    ).toBeTruthy();
    expect(screen.getByTestId('fleet-readiness-summary').textContent).toContain(
      'fleets.departures.readiness.cannot_meet: 1',
    );
    // The chart loads lazily.
    expect(await screen.findByTestId('charging-plan-chart')).toBeTruthy();
    expect(screen.queryByTestId('fleet-readiness-not-planning')).toBeNull();
    // The session start shows in depot time: 09:00 UTC is 1:00 in Los Angeles.
    expect(within(screen.getByTestId('unidentified-row-ses_9')).getByText(/1:00/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'sites.fleetReadiness.recalculate' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/charging-plan/recalculate', {});
    });
  });

  it('hides the chart, the states and Recalculate while planning is off and says why', async () => {
    wrap(plan({ planning: false, notPlanningReason: 'strategy', plan: null }));
    const row = await screen.findByTestId('readiness-row-vdp_1');
    expect(screen.getByTestId('fleet-readiness-not-planning').textContent).toContain(
      'sites.fleetReadiness.notPlanningStrategy',
    );
    expect(within(row).queryByText('fleets.departures.readiness.cannot_meet')).toBeNull();
    expect(screen.queryByTestId('fleet-readiness-summary')).toBeNull();
    expect(screen.queryByTestId('charging-plan-chart')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sites.fleetReadiness.recalculate' })).toBeNull();
    // The stations of the vehicles still show.
    expect(
      within(row).getByText('sites.fleetReadiness.stationWithEvse:station=CS-DEPOT-1,evse=1'),
    ).toBeTruthy();
  });

  it('names the setting when fleet charging is off', async () => {
    wrap(plan({ planning: false, notPlanningReason: 'fleet_charging_disabled' }));
    expect((await screen.findByTestId('fleet-readiness-not-planning')).textContent).toContain(
      'sites.fleetReadiness.notPlanningSetting',
    );
  });

  it('hides the departure details when the reply leaves them out (no fleets:read)', async () => {
    const view = plan();
    delete view.departures;
    wrap(view);
    expect(await screen.findByText('sites.fleetReadiness.noFleetAccess')).toBeTruthy();
    expect(screen.queryByTestId('readiness-row-vdp_1')).toBeNull();
    expect(screen.queryByTestId('fleet-readiness-summary')).toBeNull();
  });

  it('offers no Recalculate without loadManagement:write and no Assign without sessions:write', async () => {
    perms.delete('loadManagement:write');
    perms.delete('sessions:write');
    wrap(plan());
    await screen.findByTestId('unidentified-row-ses_9');
    expect(screen.queryByRole('button', { name: 'sites.fleetReadiness.recalculate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sites.fleetReadiness.assignVehicle' })).toBeNull();
  });

  it('assigns a vehicle to a session the CSMS could not identify', async () => {
    putMock.mockResolvedValue({});
    wrap(plan());
    const row = await screen.findByTestId('unidentified-row-ses_9');
    fireEvent.click(
      within(row).getByRole('button', { name: 'sites.fleetReadiness.assignVehicle' }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Ford E-Transit (VAN-9)');
    expect(within(dialog).queryByText('sites.fleetReadiness.noVehicleToAssign')).toBeNull();
    // The depot's vehicles are offered too.
    expect(within(dialog).getByText('BYD K9 (BUS-12)')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.vehicle'), {
      target: { value: 'veh_9' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'sites.fleetReadiness.assignVehicle' }),
    );
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/sessions/ses_9/vehicle', { vehicleId: 'veh_9' });
    });
  });

  it('says so when no vehicle can be listed', async () => {
    perms.delete('drivers:read');
    const view = plan();
    delete view.departures;
    wrap(view);
    const row = await screen.findByTestId('unidentified-row-ses_9');
    fireEvent.click(
      within(row).getByRole('button', { name: 'sites.fleetReadiness.assignVehicle' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('sites.fleetReadiness.noVehicleToAssign')).toBeTruthy();
  });

  it('asks for a vehicle before sending the assignment', async () => {
    wrap(plan());
    const row = await screen.findByTestId('unidentified-row-ses_9');
    fireEvent.click(
      within(row).getByRole('button', { name: 'sites.fleetReadiness.assignVehicle' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'sites.fleetReadiness.assignVehicle' }),
    );
    expect(await within(dialog).findByText('validation.selectRequired')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });
});
