// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { ApiError } from '@/lib/api';
import { UnitBudgetDialog } from '../UnitBudgetDialog';
import type { UnitBudgetUnit } from '../StationUnitBudgetRows';

const URL = '/v1/sites/sit_u/stations/sta_u/units/unt_1/load-budget';

const AC_UNIT: UnitBudgetUnit = {
  unitId: 'unt_1',
  name: 'Box 1',
  evseNumbers: [1, 2],
  chargingKind: 'ac',
  budget: null,
};

function renderDialog(
  unit: UnitBudgetUnit,
  defaultPhases: number | null = 3,
): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UnitBudgetDialog
        siteId="sit_u"
        stationId="sta_u"
        unit={unit}
        defaultPhases={defaultPhases}
        open
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UnitBudgetDialog', () => {
  it('stores an AC budget with the circuit phases and closes', async () => {
    apiMock.put.mockResolvedValue({});
    const { onClose } = renderDialog(AC_UNIT);
    expect(screen.getByLabelText<HTMLSelectElement>('loadManagement.unitBudgetKind').disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxCurrent'), {
      target: { value: '32' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith(URL, { kind: 'ac', maxCurrentA: 32 });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('sends the phases picked', async () => {
    apiMock.put.mockResolvedValue({});
    renderDialog(AC_UNIT);
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxCurrent'), {
      target: { value: '16' },
    });
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetPhases'), {
      target: { value: '1' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith(URL, { kind: 'ac', maxCurrentA: 16, phases: 1 });
    });
  });

  it.each(['5', '1000.5', ''])('refuses %j A before any request', (value) => {
    renderDialog(AC_UNIT);
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxCurrent'), {
      target: { value },
    });
    save();
    expect(screen.getByRole('alert').textContent).toBe('loadManagement.unitBudgetCurrentRange');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('asks for the phases of a station on no circuit', () => {
    renderDialog(AC_UNIT, null);
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxCurrent'), {
      target: { value: '32' },
    });
    save();
    expect(screen.getByRole('alert').textContent).toBe('loadManagement.unitBudgetPhasesRequired');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('stores a DC budget in kW', async () => {
    apiMock.put.mockResolvedValue({});
    renderDialog({ ...AC_UNIT, chargingKind: 'dc' });
    expect(screen.queryByLabelText('loadManagement.unitBudgetMaxCurrent')).toBeNull();
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxPower'), {
      target: { value: '150' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith(URL, { kind: 'dc', maxPowerKw: 150 });
    });
  });

  it('removes an existing budget', async () => {
    apiMock.delete.mockResolvedValue({ removed: true });
    const { onClose } = renderDialog({
      ...AC_UNIT,
      budget: { kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null },
    });
    expect(
      screen.getByLabelText<HTMLInputElement>('loadManagement.unitBudgetMaxCurrent').value,
    ).toBe('32');
    fireEvent.click(screen.getByRole('button', { name: /loadManagement\.unitBudgetRemove/ }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith(URL);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows a refusal of the API and stays open', async () => {
    apiMock.put.mockRejectedValue(
      new ApiError(400, { error: 'mismatch', code: 'UNIT_LOAD_BUDGET_KIND_MISMATCH' }),
    );
    const { onClose } = renderDialog({ ...AC_UNIT, chargingKind: null });
    fireEvent.change(screen.getByLabelText('loadManagement.unitBudgetMaxCurrent'), {
      target: { value: '32' },
    });
    save();
    // The test i18n has no catalog, so the message falls back to the API text.
    expect((await screen.findByRole('alert')).textContent).toBe('mismatch');
    expect(onClose).not.toHaveBeenCalled();
  });
});
