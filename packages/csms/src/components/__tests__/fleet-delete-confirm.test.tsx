// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, deleteMock } = vi.hoisted(() => ({ getMock: vi.fn(), deleteMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, delete: deleteMock, patch: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  },
}));

vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => true }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/charts/EnergyChart', () => ({ EnergyChart: () => null }));

import { ApiError } from '@/lib/api';
import { FleetDetailsTab } from '../fleet/FleetDetailsTab';

const FLEET = {
  id: 'flt_1',
  name: 'Delivery Vans',
  description: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FleetDetailsTab fleetId={FLEET.id} fleet={FLEET} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function confirmButton(): HTMLButtonElement {
  const button = within(screen.getByRole('dialog'))
    .getAllByRole('button')
    .find((b) => b.textContent === 'common.delete');
  if (!(button instanceof HTMLButtonElement)) throw new Error('no confirm button');
  return button;
}

beforeEach(() => {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/drivers') ? { data: [], total: 0 } : url.includes('energy') ? [] : null,
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FleetDetailsTab delete', () => {
  it('deletes only after the confirmation', async () => {
    deleteMock.mockResolvedValue(FLEET);
    renderTab();
    fireEvent.click(await screen.findByText('common.delete'));
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByText('fleets.deleteFleetTitle')).toBeDefined();
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/fleets/flt_1');
    });
  });

  it('shows a refusal in the dialog', async () => {
    deleteMock.mockRejectedValue(
      new ApiError(409, { code: 'FLEET_HAS_RESERVATIONS', error: 'The fleet has reservations' }),
    );
    renderTab();
    fireEvent.click(await screen.findByText('common.delete'));
    fireEvent.click(confirmButton());
    expect(await screen.findByText('The fleet has reservations')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});
