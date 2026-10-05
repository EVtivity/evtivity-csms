// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'USD', isError: false, refetch: vi.fn() }),
}));

import { PricingScheduleCard } from '../pricing-schedule-card';

function renderCard(timezone?: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PricingScheduleCard groupId="pgr_1" timezone={timezone} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('PricingScheduleCard', () => {
  it('asks for the schedule in the timezone given', async () => {
    getMock.mockResolvedValue([]);
    renderCard('America/Los_Angeles');
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        '/v1/pricing-groups/pgr_1/schedule?timezone=America%2FLos_Angeles',
      );
    });
  });

  it('leaves the timezone to the API without one', async () => {
    getMock.mockResolvedValue([]);
    renderCard();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/pricing-groups/pgr_1/schedule');
    });
  });
});
