// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, patchMock, putMock, deleteMock, canWrite } = vi.hoisted(() => ({
  postMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
  }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: postMock, patch: patchMock, put: putMock, delete: deleteMock },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => canWrite.value }));

import { StationUnitsCard } from '../station/StationUnitsCard';
import type { StationUnit } from '@/lib/station-units';

const UNITS: StationUnit[] = [
  {
    id: 'unt_box1',
    stationId: 'sta_1',
    name: 'Box 1',
    sortOrder: 0,
    evseIds: [],
    evseNumbers: [1, 2],
  },
  {
    id: 'unt_box2',
    stationId: 'sta_1',
    name: 'Box 2',
    sortOrder: 1,
    evseIds: [],
    evseNumbers: [3, 4],
  },
];
const EVSES = [
  { evseId: 1, unitId: 'unt_box1' },
  { evseId: 2, unitId: 'unt_box1' },
  { evseId: 3, unitId: 'unt_box2' },
  { evseId: 4, unitId: null },
];

function renderCard(units: StationUnit[] = UNITS) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationUnitsCard stationId="sta_1" units={units} evses={EVSES} />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite.value = true;
});

describe('StationUnitsCard', () => {
  it('says the station has no units and offers Add Unit', () => {
    renderCard([]);
    expect(screen.getByText('stationUnits.empty')).toBeDefined();
    expect(screen.getByRole('button', { name: 'stationUnits.addUnit' })).toBeDefined();
  });

  it('adds a unit by name and reloads the units and connectors', async () => {
    postMock.mockResolvedValue({});
    const queryClient = renderCard();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'stationUnits.addUnit' }));
    fireEvent.change(screen.getByLabelText('stationUnits.unitName'), {
      target: { value: 'Box 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/units', { name: 'Box 3' });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['stations', 'sta_1', 'units'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['stations', 'sta_1', 'connectors'] });
  });

  it('moves an EVSE into a unit and out of every unit', async () => {
    putMock.mockResolvedValue({ changed: true });
    renderCard();
    fireEvent.change(screen.getByLabelText('charts.evse:{"id":4}'), {
      target: { value: 'unt_box2' },
    });
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/4/unit', {
        unitId: 'unt_box2',
      });
    });
    fireEvent.change(screen.getByLabelText('charts.evse:{"id":1}'), { target: { value: '' } });
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/1/unit', { unitId: null });
    });
  });

  it('deletes a unit after the confirmation', async () => {
    deleteMock.mockResolvedValue({ success: true });
    renderCard();
    const [first] = screen.getAllByRole('button', { name: 'stationUnits.deleteUnit' });
    if (first == null) throw new Error('no delete button');
    fireEvent.click(first);
    const confirm = await screen.findAllByRole('button', { name: 'stationUnits.deleteUnit' });
    const last = confirm.at(-1);
    if (last == null) throw new Error('no confirm button');
    fireEvent.click(last);
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/stations/sta_1/units/unt_box1');
    });
  });

  it('is read-only without stations:write', () => {
    canWrite.value = false;
    renderCard();
    expect(screen.queryByRole('button', { name: 'stationUnits.addUnit' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByText('Box 1').length).toBeGreaterThan(0);
    expect(screen.getByText('stationUnits.noUnit')).toBeDefined();
  });
});
