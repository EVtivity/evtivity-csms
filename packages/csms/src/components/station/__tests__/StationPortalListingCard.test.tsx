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

import { StationPortalListingCard } from '../StationPortalListingCard';

function renderCard(portalListed: boolean): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StationPortalListingCard stationId="sta_1" portalListed={portalListed} />
    </QueryClientProvider>,
  );
}

function toggle(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('switch', { name: 'stations.portalListing.label' });
}

afterEach(() => {
  cleanup();
  perms.clear();
  vi.clearAllMocks();
});

describe('StationPortalListingCard', () => {
  it('shows whether the driver portal lists the station', () => {
    renderCard(true);
    expect(screen.getByText('stations.portalListing.title')).toBeTruthy();
    expect(screen.getByText('stations.portalListing.help')).toBeTruthy();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('cannot be changed without stations:write', () => {
    renderCard(true);
    expect(toggle().disabled).toBe(true);
  });

  it('takes the station out of the portal listings', async () => {
    perms.add('stations:write');
    apiMock.patch.mockResolvedValue({});
    renderCard(true);
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/stations/sta_1', { portalListed: false });
    });
  });

  it('lists an unlisted station again', async () => {
    perms.add('stations:write');
    apiMock.patch.mockResolvedValue({});
    renderCard(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/stations/sta_1', { portalListed: true });
    });
  });
});
