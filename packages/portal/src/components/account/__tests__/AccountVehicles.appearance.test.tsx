// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: vi.fn(), patch: patchMock, delete: vi.fn() }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { AccountVehicles } from '../AccountVehicles';

function renderVehicles(acPhases: number | null = null): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/portal/vehicles') {
      return Promise.resolve([
        {
          id: 'veh_1',
          make: 'Kia',
          model: 'EV9',
          year: '2025',
          color: 'green',
          bodyType: 'suv',
          acPhases,
          vin: null,
          evccid: null,
          autochargeEnabled: false,
          autochargeBlocked: false,
          lastSeen: null,
        },
      ]);
    }
    if (path.startsWith('/v1/portal/vehicles/lookup'))
      return Promise.resolve({ makes: [], models: [] });
    return Promise.resolve({});
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountVehicles />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
});

describe('AccountVehicles color and body type', () => {
  it("shows a vehicle's color and body type and saves a change", async () => {
    patchMock.mockResolvedValue({});
    renderVehicles();
    const color = await screen.findByLabelText<HTMLSelectElement>('vehicles.color: Kia EV9');
    const body = screen.getByLabelText<HTMLSelectElement>('vehicles.bodyType: Kia EV9');
    expect(color.value).toBe('green');
    expect(body.value).toBe('suv');

    fireEvent.change(color, { target: { value: 'white' } });
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/portal/vehicles/veh_1', {
        color: 'white',
        bodyType: 'suv',
      });
    });
  });

  it('offers both selects, Not Set first, in the add form', async () => {
    renderVehicles();
    await screen.findByLabelText<HTMLSelectElement>('vehicles.color: Kia EV9');
    const addColor = screen.getByLabelText<HTMLSelectElement>('vehicles.color');
    expect(addColor.value).toBe('');
    expect(addColor.options[0]?.textContent).toBe('vehicles.color: vehicles.notSet');
    expect(screen.getByLabelText<HTMLSelectElement>('vehicles.bodyType')).toBeTruthy();
  });
});

describe('AccountVehicles AC phases', () => {
  it('never shows the AC phases, which only operators keep', async () => {
    renderVehicles(3);
    await screen.findByLabelText<HTMLSelectElement>('vehicles.color: Kia EV9');
    expect(screen.queryByText('vehicles.acPhases')).toBeNull();
    expect(screen.queryByText('vehicles.acPhasesThree')).toBeNull();
  });
});
