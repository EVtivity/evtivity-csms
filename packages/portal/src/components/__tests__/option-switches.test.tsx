// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/components/PowerChart', () => ({
  PowerChart: () => <div data-testid="power-chart" />,
}));
vi.mock('@/components/EnergyChart', () => ({
  EnergyChart: () => <div data-testid="energy-chart" />,
}));

import { SessionCharts } from '../SessionCharts';
import { Reservations } from '../../pages/Reservations';
import { StationSearchList } from '../StationSearchList';

function wrap(ui: React.ReactNode): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('portal option switches', () => {
  it('switches the session chart between Energy and Power', () => {
    const points = [
      { timestamp: '2026-01-01T00:00:00Z', powerW: 7000, energyWh: 0 },
      { timestamp: '2026-01-01T00:01:00Z', powerW: 7200, energyWh: 120 },
    ];
    render(
      <SessionCharts
        powerData={points}
        energyData={points}
        currentPowerW={7200}
        energyDeliveredWh="120"
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'sessionDetail.chartView' });
    expect(group).toBeDefined();
    expect(screen.getByTestId('energy-chart')).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: 'sessionDetail.power' }));
    expect(screen.getByTestId('power-chart')).toBeDefined();
    expect(screen.getByText('7.2 kW')).toBeDefined();
  });

  it('shows no switch for a session without power data', () => {
    const energy = [
      { timestamp: '2026-01-01T00:00:00Z', energyWh: 0 },
      { timestamp: '2026-01-01T00:01:00Z', energyWh: 120 },
    ];
    render(<SessionCharts powerData={[]} energyData={energy} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('splits reservations into Upcoming and Past', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/v1/portal/reservations') {
        return Promise.resolve({
          data: [
            {
              id: 'r1',
              reservationId: 1,
              stationOcppId: 'UP-STATION',
              status: 'scheduled',
              startsAt: null,
              expiresAt: '2030-01-01T00:00:00Z',
              createdAt: '2026-01-01T00:00:00Z',
              cancellationFee: null,
            },
            {
              id: 'r2',
              reservationId: 2,
              stationOcppId: 'PAST-STATION',
              status: 'used',
              startsAt: null,
              expiresAt: '2026-01-01T00:00:00Z',
              createdAt: '2026-01-01T00:00:00Z',
              cancellationFee: null,
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    render(wrap(<Reservations />));
    const group = screen.getByRole('radiogroup', { name: 'reservations.viewLabel' });
    expect(group.className.split(' ')).toContain('w-full');
    expect(await screen.findByText('UP-STATION')).toBeDefined();
    expect(screen.queryByText('PAST-STATION')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'reservations.past' }));
    expect(await screen.findByText('PAST-STATION')).toBeDefined();
    expect(screen.queryByText('UP-STATION')).toBeNull();
  });

  it('switches the station search between our network and partner networks', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/v1/security/public')) return Promise.resolve({ roamingEnabled: true });
      return Promise.resolve([]);
    });
    render(wrap(<StationSearchList onSelect={() => undefined} />));
    const local = await screen.findByRole('radio', { name: 'chargerSearch.ourNetwork' });
    expect(local.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByPlaceholderText('chargerSearch.searchPlaceholder')).toBeDefined();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(
        screen
          .getByRole('radio', { name: 'chargerSearch.partnerNetworks' })
          .getAttribute('aria-checked'),
      ).toBe('true');
    });
    expect(screen.getByPlaceholderText('chargerSearch.roamingSearchPlaceholder')).toBeDefined();
  });

  it('hides the network switch without roaming', async () => {
    getMock.mockResolvedValue({ roamingEnabled: false });
    render(wrap(<StationSearchList onSelect={() => undefined} />));
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
