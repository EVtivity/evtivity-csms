// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock } };
});

import { MatchingStationsCard } from '../MatchingStationsCard';

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MatchingStationsCard
        endpoint="/v1/config-templates/tpl_1/matching-stations"
        queryKey={['t']}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MatchingStationsCard', () => {
  it('sorts on the server: ascending, then descending, then the default order', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 'sta_1',
          stationId: 'CS-1',
          model: 'X',
          isOnline: true,
          siteName: 'North',
          vendorName: 'V',
        },
      ],
      total: 1,
    });
    renderCard();
    const header = await screen.findByTestId('sort-site');
    fireEvent.click(header);
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(
        '/v1/config-templates/tpl_1/matching-stations?page=1&limit=10&sort=site&order=asc',
      );
    });
    fireEvent.click(await screen.findByTestId('sort-site'));
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(
        '/v1/config-templates/tpl_1/matching-stations?page=1&limit=10&sort=site&order=desc',
      );
    });
    fireEvent.click(await screen.findByTestId('sort-site'));
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(
        '/v1/config-templates/tpl_1/matching-stations?page=1&limit=10',
      );
    });
  });
});
