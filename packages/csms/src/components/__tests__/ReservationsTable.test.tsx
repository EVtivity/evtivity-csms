// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const RESERVATION = {
  id: 'rsv_internal_1',
  reservationId: 42,
  stationId: 'sta_1',
  stationOcppId: 'CP-001',
  siteName: null,
  evseOcppId: 1,
  driverId: null,
  driverFirstName: null,
  driverLastName: null,
  status: 'active',
  startsAt: null,
  expiresAt: '2026-11-01T11:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  sessionId: null,
};

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn((url: string) =>
      Promise.resolve(
        url.startsWith('/v1/reservations')
          ? { data: [RESERVATION], total: 1 }
          : { data: [], total: 0 },
      ),
    ),
  },
}));

import { RESERVATION_SORT_KEYS, ReservationsTable } from '@/components/ReservationsTable';
import { Reservations } from '@/pages/Reservations';

function renderWithProviders(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectNumberFirst(): Promise<void> {
  const row = await screen.findByTestId('reservation-row-rsv_internal_1');
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers[0]?.startsWith('reservations.reservationId')).toBe(true);
  const firstCell = within(row).getAllByRole('cell')[0];
  expect(firstCell?.textContent).toBe('#42');
  expect(firstCell?.className).toContain('text-link');
  expect(document.body.textContent).not.toContain('rsv_internal_1');
}

afterEach(() => {
  cleanup();
});

describe('reservation lists', () => {
  it('sorts by the reservation number', () => {
    expect(RESERVATION_SORT_KEYS[0]).toBe('reservationId');
  });

  it('ReservationsTable shows the reservation number first', async () => {
    renderWithProviders(<ReservationsTable stationId="sta_1" timezone="UTC" hideStationName />);
    await expectNumberFirst();
  });

  it('the Reservations page shows the reservation number first', async () => {
    renderWithProviders(<Reservations />);
    await expectNumberFirst();
  });
});
