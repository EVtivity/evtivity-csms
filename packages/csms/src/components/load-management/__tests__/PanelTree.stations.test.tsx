// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => {
  // The auth store reads the theme on import.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

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

import { PanelTree } from '../PanelTree';

const ON_CIRCUIT = {
  id: 'sta_on',
  stationId: 'CS-ON',
  currentDrawKw: 0,
  allocatedLimitKw: null,
  maxPowerKw: 7.4,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: false,
};
const OFF_CIRCUIT = { ...ON_CIRCUIT, id: 'sta_off', stationId: 'CS-OFF' };

const HIERARCHY = [
  {
    type: 'panel' as const,
    id: 'pnl_main',
    name: 'Main Panel',
    breakerRatingAmps: 200,
    voltageV: 240,
    phases: 1,
    maxContinuousKw: 38.4,
    safetyMarginKw: 0,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    currentDrawKw: 0,
    availableKw: 38.4,
    utilization: 0,
    totalConnectedKw: 7.4,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    circuits: [
      {
        id: 'cir_1',
        name: 'Circuit 1',
        breakerRatingAmps: 40,
        maxContinuousKw: 7.68,
        currentDrawKw: 0,
        availableKw: 7.68,
        stations: [ON_CIRCUIT],
        unmanagedLoads: [],
      },
    ],
    childPanels: [],
    unmanagedLoads: [],
  },
];

// The site station list of the reply carries the fields the circuit rows show.
const ON_CIRCUIT_FULL = {
  ...ON_CIRCUIT,
  currentDrawKw: 3.2,
  allocatedLimitKw: 7.4,
  loadPriority: 7,
  loadMinPowerKw: 2,
  rateUnit: 'A' as const,
  limitReserved: false,
};

function renderTree(
  props: Partial<Parameters<typeof PanelTree>[0]> = {},
  station: Record<string, unknown> = ON_CIRCUIT_FULL,
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PanelTree
        siteId="site1"
        hierarchy={HIERARCHY}
        stations={[station as typeof ON_CIRCUIT_FULL, OFF_CIRCUIT]}
        transformers={[]}
        canWrite
        strategy="priority_based"
        onRefresh={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'loadManagement.expand' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PanelTree stations on a circuit', () => {
  it('lists stations not on a circuit under their own heading, without the row controls', () => {
    renderTree();
    expect(screen.getByText('loadManagement.stationsNotOnCircuit')).toBeTruthy();
    expect(screen.getByText('loadManagement.stationsNotOnCircuitWarning')).toBeTruthy();
    expect(screen.getByText('CS-OFF')).toBeTruthy();
    expect(screen.queryByTestId('circuit-station-CS-OFF')).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'loadManagement.minPowerFor:{"stationId":"CS-OFF"}' }),
    ).toBeNull();
  });

  it('shows status, session, limit unit, priority and min power on the station row', () => {
    renderTree();
    const row = within(screen.getByTestId('circuit-station-CS-ON'));
    expect(row.getByText('status.online')).toBeTruthy();
    expect(row.getByText('common.na')).toBeTruthy();
    expect(row.getByTestId('circuit-station-rate-unit').textContent).toBe('A');
    const priority = row.getByRole('combobox', {
      name: 'loadManagement.priorityFor:{"stationId":"CS-ON"}',
    });
    expect((priority as HTMLSelectElement).value).toBe('7');
    const minPower = row.getByLabelText('loadManagement.minPowerFor:{"stationId":"CS-ON"}');
    expect((minPower as HTMLInputElement).value).toBe('2');
    expect(row.queryByTestId('circuit-station-reserved')).toBeNull();
  });

  it('marks a reserved value as reserved, not sent', () => {
    renderTree({}, { ...ON_CIRCUIT_FULL, limitReserved: true });
    const badge = screen.getByTestId('circuit-station-reserved');
    expect(badge.textContent).toBe('loadManagement.limitReserved');
    expect(badge.getAttribute('title')).toBe('loadManagement.limitReservedNote');
  });

  it('saves a priority change while the strategy is Priority Based', async () => {
    apiMock.patch.mockResolvedValue({});
    renderTree();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'loadManagement.priorityFor:{"stationId":"CS-ON"}' }),
      { target: { value: '9' } },
    );
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/site1/stations/sta_on/load-priority', {
        loadPriority: 9,
      });
    });
  });

  it('shows the priority read only with the reason under another strategy', () => {
    renderTree({ strategy: 'equal_share' });
    const row = within(screen.getByTestId('circuit-station-CS-ON'));
    expect(row.queryByRole('combobox')).toBeNull();
    expect(row.getByText('7')).toBeTruthy();
    expect(row.getAllByText('loadManagement.priorityStrategyOnly').length).toBeGreaterThan(0);
  });

  it('saves Min Power on blur and sends nothing above 1000 kW', async () => {
    apiMock.patch.mockResolvedValue({});
    renderTree();
    const input = screen.getByLabelText('loadManagement.minPowerFor:{"stationId":"CS-ON"}');
    fireEvent.change(input, { target: { value: '2000' } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('2');
    expect(apiMock.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '3.5' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/site1/stations/sta_on/load-min-power', {
        loadMinPowerKw: 3.5,
      });
    });
  });

  it('is read only without loadManagement:write', () => {
    renderTree({ canWrite: false });
    const row = within(screen.getByTestId('circuit-station-CS-ON'));
    expect(row.queryByRole('combobox')).toBeNull();
    expect(row.queryByRole('textbox')).toBeNull();
    expect(row.queryByRole('button', { name: 'loadManagement.removeStation' })).toBeNull();
    expect(row.getByText('7')).toBeTruthy();
    expect(row.getByText('2')).toBeTruthy();
  });

  it('opens Add Station from the circuit', () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.addStation' }));
    const dialog = screen.getByRole('dialog', { name: 'loadManagement.addStation' });
    expect(within(dialog).getByRole('button', { name: /loadManagement.addStation/ })).toBeTruthy();
  });

  it('keeps the station on the circuit when Remove is cancelled', () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.removeStation' }));
    const dialog = screen.getByRole('dialog', { name: 'loadManagement.removeStationTitle' });
    expect(
      within(dialog).getByText('loadManagement.removeStationDescription:{"station":"CS-ON"}'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('takes the station off the circuit when Remove is confirmed', async () => {
    apiMock.patch.mockResolvedValue({ id: 'sta_on', stationId: 'CS-ON', circuitId: null });
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.removeStation' }));
    const dialog = screen.getByRole('dialog', { name: 'loadManagement.removeStationTitle' });
    fireEvent.click(within(dialog).getByRole('button', { name: /loadManagement.removeStation/ }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/site1/stations/sta_on/circuit', {
        circuitId: null,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
