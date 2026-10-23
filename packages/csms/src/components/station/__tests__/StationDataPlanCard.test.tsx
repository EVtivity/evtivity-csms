// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { StationDataPlanCard } from '../StationDataPlanCard';
import type { StationDataPlanState } from '../StationDataPlanCard';

const STATION: StationDataPlanState = {
  id: 'sta_1',
  dataPlan: null,
  effectiveDataPlan: 'cellular',
  dataPlanSource: 'sim',
  chargingKind: 'dc',
};

function renderCard(station: StationDataPlanState = STATION): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StationDataPlanCard station={station} />
    </QueryClientProvider>,
  );
}

function saveButton(index: number): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /common.save/ });
  const button = buttons.at(index);
  if (button == null) throw new Error('no Save button');
  return button;
}

afterEach(() => {
  cleanup();
  perms.clear();
  vi.clearAllMocks();
});

describe('StationDataPlanCard', () => {
  it('shows the plan in use, where it came from and the charging kind', () => {
    renderCard();
    expect(screen.getByText('dataPlan.plans.cellular')).toBeTruthy();
    expect(screen.getByText('dataPlan.sources.sim')).toBeTruthy();
    expect(screen.getByText('dataPlan.kinds.dc')).toBeTruthy();
  });

  it('hides the choice without stations:write', () => {
    renderCard();
    expect(screen.queryByLabelText('dataPlan.station.choice')).toBeNull();
  });

  it('saves the station choice after the confirmation', async () => {
    perms.add('stations:write');
    apiMock.patch.mockResolvedValue({});
    renderCard();
    const select = screen.getByLabelText<HTMLSelectElement>('dataPlan.station.choice');
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'wifi_or_wired' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    expect(screen.getByText('dataPlan.station.confirmDescription')).toBeTruthy();
    const confirm = saveButton(-1);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/stations/sta_1', {
        dataPlan: 'wifi_or_wired',
      });
    });
  });

  it('clears the station choice with Use the Site Plan', async () => {
    perms.add('stations:write');
    apiMock.patch.mockResolvedValue({});
    renderCard({ ...STATION, dataPlan: 'cellular', dataPlanSource: 'station' });
    fireEvent.change(screen.getByLabelText('dataPlan.station.choice'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    fireEvent.click(saveButton(-1));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/stations/sta_1', { dataPlan: null });
    });
  });
});
