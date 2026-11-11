// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, toastMock, state } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
  state: { canWrite: true, planning: false },
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
  return {
    api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() },
    ApiError,
  };
});
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => (p === 'fleets:write' ? state.canWrite : true),
}));
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: { fleetChargingEnabled: state.planning },
    isLoading: false,
    isLoaded: true,
  }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { FleetDeparturesTab } from '../FleetDeparturesTab';

const departure = {
  id: 'vdp_1',
  vehicleId: 'veh_1',
  siteId: 'sit_1',
  siteName: 'Northgate Depot',
  siteTimezone: 'America/Los_Angeles',
  vehicle: { id: 'veh_1', driverId: 'drv_1', make: 'BYD', model: 'K9', licensePlate: 'BUS-12' },
  scheduleId: null,
  occurrenceDate: null,
  departureAt: '2026-11-03T13:30:00.000Z',
  targetKind: 'energy',
  targetEnergyKwh: 120,
  targetSocPercent: null,
  priority: 5,
  source: 'manual',
  overridden: false,
  status: 'scheduled',
  outcome: null,
  readiness: 'at_risk',
  readinessReason: 'site_capacity',
  sessionId: 'ses_1',
  plannedKwh: 88,
  deliveredKwh: 45,
  shortfallKwh: 32,
  predictedReadyAt: '2026-11-03T13:10:00.000Z',
};

const schedule = {
  id: 'vds_1',
  vehicleId: 'veh_1',
  siteId: 'sit_1',
  siteName: 'Northgate Depot',
  vehicle: departure.vehicle,
  daysOfWeek: [1, 3, 5],
  departureTime: '05:30',
  targetKind: 'soc',
  targetEnergyKwh: null,
  targetSocPercent: 80,
  priority: 7,
  validFrom: null,
  validTo: null,
  isActive: true,
  notes: null,
};

function mockReads(): void {
  getMock.mockImplementation((url: string) => {
    if (url.startsWith('/v1/fleets/flt_1/departures')) {
      return Promise.resolve({ data: [departure], total: 1 });
    }
    if (url.startsWith('/v1/fleets/flt_1/departure-schedules')) {
      return Promise.resolve({ data: [schedule], total: 1 });
    }
    if (url.startsWith('/v1/sites')) {
      return Promise.resolve({
        data: [{ id: 'sit_1', name: 'Northgate Depot', timezone: 'America/Los_Angeles' }],
        total: 1,
      });
    }
    if (url.startsWith('/v1/fleets/flt_1/vehicles')) {
      return Promise.resolve({ data: [departure.vehicle], total: 1 });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function wrap(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FleetDeparturesTab fleetId="flt_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.canWrite = true;
  state.planning = false;
});

const depotDeparture = {
  ...departure,
  id: 'vdp_9',
  departureAt: null,
  adHoc: true,
  targetKind: 'soc',
  targetEnergyKwh: null,
  targetSocPercent: 60,
  targetSocMaxPercent: 90,
  expectedArrivalAt: '2026-11-03T12:10:00.000Z',
  expectedArrivalSocPercent: 35,
  requestedEvseId: 'evs_1',
  source: 'depot_system',
  depotSystemId: 'dms_1',
  externalRequestId: 'req-1',
  cancelReason: null,
  predictedMaxReadyAt: null,
};

function mockRows(rows: unknown[]): void {
  getMock.mockImplementation((url: string) => {
    if (url.startsWith('/v1/fleets/flt_1/departures')) {
      return Promise.resolve({ data: rows, total: rows.length });
    }
    if (url.startsWith('/v1/fleets/flt_1/departure-schedules')) {
      return Promise.resolve({ data: [], total: 0 });
    }
    if (url.startsWith('/v1/sites')) return Promise.resolve({ data: [], total: 0 });
    if (url.startsWith('/v1/fleets/flt_1/vehicles')) return Promise.resolve({ data: [], total: 0 });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('FleetDeparturesTab bus depot system departures', () => {
  it('shows an ad hoc request as soon as possible, its maximum and arrival, read-only', async () => {
    mockRows([{ ...depotDeparture, managedByDepotSystem: true, depotSystemName: null }]);
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_9');
    expect(within(row).getByText('fleets.departures.asSoonAsPossible')).toBeTruthy();
    expect(within(row).getByText('fleets.departures.targetUpTo:target=60%,max=90%')).toBeTruthy();
    expect(
      within(row).getByText(/fleets\.departures\.expectedArrivalWithSoc:time=4:10.*soc=35%/),
    ).toBeTruthy();
    // Without the name (the reader may not list the systems) the badge says Bus Depot System.
    expect(within(row).getByTestId('depot-system-badge').textContent).toBe(
      'fleets.departures.depotSystemBadge',
    );
    expect(within(row).getByTestId('departure-managed-vdp_9')).toBeTruthy();
    expect(within(row).queryByLabelText('fleets.departures.editDeparture')).toBeNull();
    expect(within(row).queryByLabelText('fleets.departures.cancelDeparture')).toBeNull();
    expect(getMock).not.toHaveBeenCalledWith('/v1/depot-systems');
  });

  it('names the system and allows edits once the API says no system manages it', async () => {
    mockRows([
      { ...depotDeparture, managedByDepotSystem: false, depotSystemName: 'Depot North BMS' },
    ]);
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_9');
    expect(within(row).getByTestId('depot-system-badge').textContent).toBe(
      'fleets.departures.depotSystemBadgeNamed:name=Depot North BMS',
    );
    expect(within(row).queryByTestId('departure-managed-vdp_9')).toBeNull();
    expect(within(row).getByLabelText('fleets.departures.editDeparture')).toBeTruthy();
  });

  it('shows the source of every departure', async () => {
    mockRows(
      ['manual', 'schedule', 'import', 'vehicle'].map((source) => ({
        ...departure,
        id: `vdp_${source}`,
        source,
      })),
    );
    wrap();
    for (const source of ['manual', 'schedule', 'import', 'vehicle']) {
      const row = await screen.findByTestId(`departure-row-vdp_${source}`);
      expect(within(row).getByTestId('departure-source-badge').textContent).toBe(
        `fleets.departures.sources.${source}`,
      );
    }
  });
});

describe('FleetDeparturesTab status filter', () => {
  it('lists cancelled departures of the last 30 days with their reasons and no actions', async () => {
    const cancelled = [null, 'removed_by_depot_system', 'terminated_by_depot_system'].map(
      (cancelReason, i) => ({
        ...departure,
        id: `vdp_c${String(i)}`,
        status: 'cancelled',
        readiness: null,
        readinessReason: null,
        cancelReason,
      }),
    );
    mockRows([departure]);
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    mockRows(cancelled);
    const before = Date.now();
    fireEvent.change(screen.getByLabelText('fleets.departures.statusFilter'), {
      target: { value: 'cancelled' },
    });
    const row0 = await screen.findByTestId('departure-row-vdp_c0');
    const url = getMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('status=cancelled'));
    expect(url).toBeDefined();
    const params = new URL(`http://x${url ?? ''}`).searchParams;
    const from = Date.parse(params.get('from') ?? '');
    const to = Date.parse(params.get('to') ?? '');
    expect(Math.round((before - from) / 86_400_000)).toBe(30);
    expect(Math.round((to - before) / 86_400_000)).toBe(7);
    expect(within(row0).getByTestId('departure-reason-vdp_c0').textContent).toBe(
      'fleets.departures.cancelledByPerson',
    );
    expect(
      within(screen.getByTestId('departure-row-vdp_c1')).getByTestId('departure-reason-vdp_c1')
        .textContent,
    ).toBe('fleets.departures.cancelReasons.removed_by_depot_system');
    expect(within(row0).getByText('fleets.departures.statuses.cancelled')).toBeTruthy();
    expect(within(row0).queryByLabelText('fleets.departures.editDeparture')).toBeNull();
    expect(within(row0).queryByLabelText('fleets.departures.cancelDeparture')).toBeNull();
  });

  it('keeps the default window for scheduled departures', async () => {
    mockRows([departure]);
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    expect(getMock).toHaveBeenCalledWith(
      '/v1/fleets/flt_1/departures?status=scheduled&page=1&limit=10',
    );
  });
});

describe('FleetDeparturesTab expected arrival', () => {
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  async function openAdd(): Promise<HTMLElement> {
    mockReads();
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.departures.addDeparture' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.vehicle'), {
      target: { value: 'veh_1' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.depot'), {
      target: { value: 'sit_1' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.departureDate'), {
      target: { value: day },
    });
    fireEvent.change(within(dialog).getAllByLabelText('common.hour')[0] as HTMLElement, {
      target: { value: '10' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.energyKwh'), {
      target: { value: '50' },
    });
    return dialog;
  }

  it('sends the expected arrival and its state of charge', async () => {
    postMock.mockResolvedValue(departure);
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.arrivalDate'), {
      target: { value: day },
    });
    fireEvent.change(within(dialog).getAllByLabelText('common.hour')[1] as HTMLElement, {
      target: { value: '08' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.arrivalSocPercent'), {
      target: { value: '40' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.addDeparture' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    const departs = Date.parse(String(body['departureAt']));
    const arrives = Date.parse(String(body['expectedArrivalAt']));
    expect(departs - arrives).toBe(2 * 3_600_000);
    expect(body['expectedArrivalSocPercent']).toBe(40);
  });

  it('refuses an arrival after the departure and a state of charge over 100', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.arrivalDate'), {
      target: { value: day },
    });
    fireEvent.change(within(dialog).getAllByLabelText('common.hour')[1] as HTMLElement, {
      target: { value: '11' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.arrivalSocPercent'), {
      target: { value: '150' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.addDeparture' }));
    expect(
      await within(dialog).findByText('fleets.departures.arrivalBeforeDeparture'),
    ).toBeTruthy();
    expect(within(dialog).getByText('fleets.departures.arrivalSocRange')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('asks for both the arrival date and time', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.arrivalDate'), {
      target: { value: day },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.addDeparture' }));
    expect(await within(dialog).findByText('fleets.departures.arrivalIncomplete')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('FleetDeparturesTab Up To', () => {
  it('sends the Up To state of charge and refuses one below the target', async () => {
    mockReads();
    postMock.mockResolvedValue(departure);
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.departures.addDeparture' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.targetKind'), {
      target: { value: 'soc' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.socPercent'), {
      target: { value: '80' },
    });
    fireEvent.change(within(dialog).getByLabelText('fleets.departures.upToPercent'), {
      target: { value: '70' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.addDeparture' }));
    expect(await within(dialog).findByText('fleets.departures.upToBelowTarget')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('FleetDeparturesTab', () => {
  it('lists departures and schedules and marks them not planned while planning is off', async () => {
    mockReads();
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_1');
    expect(screen.getByTestId('departures-not-planned')).toBeTruthy();
    expect(within(row).getByText('BYD K9 (BUS-12)')).toBeTruthy();
    expect(within(row).getByText('120.0 kWh')).toBeTruthy();
    // The planner columns (state, predicted ready, reason) show a dash while off.
    expect(within(row).getAllByText('-')).toHaveLength(3);
    expect(within(row).queryByText('fleets.departures.readiness.at_risk')).toBeNull();
    // 13:30 UTC is 05:30 in Los Angeles (PST, UTC-8): the depot time, not the user time.
    expect(within(row).getByText(/5:30/)).toBeTruthy();
    const scheduleRow = await screen.findByTestId('departure-schedule-row-vds_1');
    expect(within(scheduleRow).getByText('80%')).toBeTruthy();
    expect(within(scheduleRow).getByText('Mon, Wed, Fri')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith(
      '/v1/fleets/flt_1/departures?status=scheduled&page=1&limit=10',
    );
  });

  it('requests the schedules sorted by a column when its header is clicked', async () => {
    mockReads();
    wrap();
    await screen.findByTestId('departure-schedule-row-vds_1');
    fireEvent.click(screen.getByTestId('sort-priority'));
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        '/v1/fleets/flt_1/departure-schedules?page=1&limit=10&sort=priority&order=asc',
      );
    });
  });

  it('shows the readiness, the predicted ready time and the reason while planning is on', async () => {
    state.planning = true;
    mockReads();
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_1');
    expect(screen.queryByTestId('departures-not-planned')).toBeNull();
    expect(within(row).getByText('fleets.departures.readiness.at_risk')).toBeTruthy();
    expect(within(row).getByText('fleets.departures.reasons.site_capacity')).toBeTruthy();
    expect(within(row).getByText(/5:10/)).toBeTruthy();
    expect(
      within(row).getByText('fleets.departures.deliveredOf:delivered=45.0,target=120.0'),
    ).toBeTruthy();
  });

  it('offers no write controls without fleets:write', async () => {
    state.canWrite = false;
    mockReads();
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    expect(screen.queryByText('fleets.departures.addDeparture')).toBeNull();
    expect(screen.queryByText('fleets.departures.addSchedule')).toBeNull();
    expect(screen.queryByText('fleets.departures.importCsv')).toBeNull();
    expect(screen.queryByLabelText('fleets.departures.cancelDeparture')).toBeNull();
    expect(screen.queryByLabelText('fleets.departures.editSchedule')).toBeNull();
    // The vehicle list is only read for the dialogs.
    expect(getMock).not.toHaveBeenCalledWith('/v1/fleets/flt_1/vehicles?page=1&limit=100');
  });

  it('cancels a departure only after the confirmation', async () => {
    mockReads();
    postMock.mockResolvedValue({ ...departure, status: 'cancelled', changed: true });
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(within(row).getByLabelText('fleets.departures.cancelDeparture'));
    const dialog = await screen.findByRole('dialog');
    expect(postMock).not.toHaveBeenCalled();
    expect(within(dialog).getByText('fleets.departures.confirmCancel')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'fleets.departures.cancelDeparture' }),
    );
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/departures/vdp_1/cancel', {});
    });
  });

  it('keeps the departure when the confirmation is dismissed', async () => {
    mockReads();
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(within(row).getByLabelText('fleets.departures.cancelDeparture'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'fleets.departures.keepDeparture' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('imports a CSV file and lists the refused rows by row number and field', async () => {
    mockReads();
    postMock.mockResolvedValue({
      created: 2,
      updated: 1,
      unchanged: 0,
      refused: [{ row: 4, field: 'vehicle', reason: 'not_found' }],
    });
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.departures.importCsv' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const csv =
      'vehicle,site,departure,energy_kwh\r\nBUS-12,Northgate Depot,2026-11-03 05:30,120\r\n';
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [new File([csv], 'departures.csv', { type: 'text/csv' })] },
    });
    expect(await within(dialog).findByTestId('departure-import-file')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.importCsv' }));
    const result = await within(dialog).findByTestId('departure-import-result');
    expect(postMock).toHaveBeenCalledWith('/v1/fleets/flt_1/departures/import', {
      csv: 'vehicle,site,departure,energy_kwh\nBUS-12,Northgate Depot,2026-11-03 05:30,120\n',
    });
    expect(within(result).getByText('fleets.departures.importCreated:count=2')).toBeTruthy();
    expect(within(result).getByText('fleets.departures.importUpdated:count=1')).toBeTruthy();
    const refused = within(result).getByTestId('departure-import-refused');
    expect(refused.textContent).toContain('row=4');
    expect(refused.textContent).toContain('field=vehicle');
  });

  it('refuses to send an import without a file', async () => {
    mockReads();
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.departures.importCsv' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.importCsv' }));
    expect(await within(dialog).findByText('fleets.departures.importChooseFile')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('opens the edit dialog in the depot time of the row, and waits when the zone is unknown', async () => {
    mockReads();
    wrap();
    const row = await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(within(row).getByLabelText('fleets.departures.editDeparture'));
    const dialog = await screen.findByRole('dialog');
    const dateField: HTMLInputElement = within(dialog).getByLabelText(
      'fleets.departures.departureDate',
    );
    expect(dateField.value).toBe('2026-11-03');
    expect(within(dialog).getByText(/America\/Los_Angeles/)).toBeTruthy();
    cleanup();

    // A row without its zone while the site list has not answered: no fields yet.
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/v1/fleets/flt_1/departures')) {
        return Promise.resolve({ data: [{ ...departure, siteTimezone: undefined }], total: 1 });
      }
      if (url.startsWith('/v1/fleets/flt_1/departure-schedules')) {
        return Promise.resolve({ data: [], total: 0 });
      }
      return new Promise(() => undefined);
    });
    wrap();
    const pending = await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(within(pending).getByLabelText('fleets.departures.editDeparture'));
    const waiting = await screen.findByRole('dialog');
    expect(within(waiting).queryByLabelText('fleets.departures.departureDate')).toBeNull();
    expect(within(waiting).getByRole('status')).toBeTruthy();
  });

  it('checks the schedule form before sending it', async () => {
    mockReads();
    wrap();
    await screen.findByTestId('departure-row-vdp_1');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.departures.addSchedule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.departures.addSchedule' }));
    expect((await within(dialog).findAllByText('validation.selectRequired')).length).toBe(2);
    expect(postMock).not.toHaveBeenCalled();
  });
});
