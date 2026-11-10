// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site map card without a map: the not-configured note keeps the map
// height, so the card is as tall as with the map.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@googlemaps/js-api-loader', () => ({
  setOptions: vi.fn(),
  importLibrary: vi.fn(),
}));

vi.mock('@/hooks/use-google-maps-settings', () => ({
  useGoogleMapsSettings: () => ({ data: { apiKey: '' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: () => Promise.resolve([]) },
}));

import { StationMapChart } from '../StationMapChart';

afterEach(cleanup);

describe('StationMapChart without a map', () => {
  it('shows the not-configured note at the map height', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StationMapChart />
      </QueryClientProvider>,
    );
    expect(screen.getByText('dashboard.siteMapNotConfigured')).toBeTruthy();
    expect(screen.getByTestId('station-map-placeholder').className).toContain('h-96');
  });
});
