// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  id: 'sta_units',
  stationId: 'EM4-MASTER-01',
  currentDrawKw: 0,
  allocatedLimitKw: 44,
  maxPowerKw: 88,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: true,
  balancingMode: 'evse',
  evseLimitsRefusedAt: null,
  usesUnits: true,
  evseLimits: [
    { evseNumber: 1, unitId: 'unt_box1', kind: 'ac', limitA: 16, limitKw: 11.04, paused: false },
    { evseNumber: 2, unitId: 'unt_box1', kind: 'ac', limitA: 0, limitKw: 0, paused: true },
  ],
};

const REPLY = {
  stationId: 'sta_units',
  defaultPhases: 3,
  units: [
    {
      unitId: 'unt_box1',
      name: 'Box 1',
      evseNumbers: [1, 2],
      chargingKind: 'ac',
      budget: { kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null },
    },
    { unitId: 'unt_box2', name: 'Box 2', evseNumbers: [3, 4], chargingKind: 'ac', budget: null },
    {
      unitId: 'unt_box3',
      name: 'Box 3',
      evseNumbers: [5, 6],
      chargingKind: 'mixed',
      budget: null,
    },
  ],
};

function renderTable(station: CircuitStationStatus, canWrite: boolean): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CircuitStationTable
        siteId="sit_units"
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

describe('CircuitStationTable unit budgets', () => {
  it('shows a sub-row per unit with its budget and the limits of its EVSEs', async () => {
    apiMock.get.mockResolvedValue(REPLY);
    renderTable(STATION, true);
    const box1 = await screen.findByTestId('unit-budget-row-unt_box1');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/sit_units/stations/sta_units/unit-budgets');
    expect(within(box1).getByTestId('unit-budget-value').textContent).toBe(
      'loadManagement.unitBudgetAcThreePhase:{"amps":"32"}',
    );
    expect(within(box1).getByTestId('unit-budget-limits').textContent).toContain(
      'loadManagement.unitBudgetEvseLimit:{"evse":1,"limit":"16 A"}',
    );
    expect(within(box1).getByTestId('unit-budget-limits').textContent).toContain(
      '"limit":"loadManagement.unitBudgetPaused"',
    );
    const box2 = screen.getByTestId('unit-budget-row-unt_box2');
    expect(within(box2).getByTestId('unit-budget-value').textContent).toBe(
      'loadManagement.unitBudgetNone',
    );
    const box3 = screen.getByTestId('unit-budget-row-unt_box3');
    expect(box3.textContent).toContain('loadManagement.unitBudgetMixed');
    expect(within(box3).queryByRole('button')).toBeNull();
  });

  it('opens the unit budget dialog from Edit', async () => {
    apiMock.get.mockResolvedValue(REPLY);
    renderTable(STATION, true);
    fireEvent.click(
      await screen.findByLabelText('loadManagement.unitBudgetEditFor:{"unit":"Box 2"}'),
    );
    expect(
      screen.getByRole('dialog', { name: 'loadManagement.unitBudgetTitle:{"unit":"Box 2"}' }),
    ).toBeTruthy();
  });

  it('shows the budgets read only without loadManagement:write', async () => {
    apiMock.get.mockResolvedValue(REPLY);
    renderTable(STATION, false);
    const box1 = await screen.findByTestId('unit-budget-row-unt_box1');
    expect(within(box1).queryByRole('button')).toBeNull();
  });

  it('reads no unit budgets for a station without units', () => {
    renderTable({ ...STATION, usesUnits: false }, true);
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('unit-budget-row-unt_box1')).toBeNull();
  });

  it('says when the budgets could not be read', async () => {
    apiMock.get.mockRejectedValue(new Error('down'));
    renderTable(STATION, true);
    expect(await screen.findByText('loadManagement.unitBudgetLoadFailed')).toBeTruthy();
  });
});
