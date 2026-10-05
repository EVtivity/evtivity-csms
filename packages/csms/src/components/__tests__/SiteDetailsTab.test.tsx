// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock, putMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, patch: patchMock, put: putMock },
}));

vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));
vi.mock('@/lib/timezone', () => ({
  TIMEZONE_OPTIONS: [],
  formatDateTime: (value: string) => `date:${value}`,
}));

import { Tabs } from '@/components/ui/tabs';
import { SiteDetailsTab } from '../site/SiteDetailsTab';

const SITE = {
  id: 'sit_1',
  name: 'Main Street',
  address: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  latitude: null,
  longitude: null,
  timezone: 'Europe/Berlin',
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  contactIsPublic: false,
  hoursOfOperation: null,
  reservationsEnabled: true,
  freeVendEnabled: false,
  freeVendTemplateId21: null,
  freeVendTemplateId16: null,
  carbonRegionCode: null,
  stationMessageLanguage: null as string | null,
  stationCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function renderTab(site = SITE): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Tabs value="details" onValueChange={() => undefined}>
        <SiteDetailsTab
          site={site}
          siteId={site.id}
          googleMapsApiKey=""
          onDelete={() => undefined}
          deleteIsPending={false}
        />
      </Tabs>
    </QueryClientProvider>,
  );
}

function languageSelect(): HTMLSelectElement {
  const element = screen.getByLabelText('sites.stationMessageLanguage');
  if (!(element instanceof HTMLSelectElement)) throw new Error('not a select');
  return element;
}

describe('SiteDetailsTab station display language', () => {
  beforeEach(() => {
    getMock.mockResolvedValue([]);
    patchMock.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the company default when the site has no language', () => {
    renderTab();
    expect(languageSelect().value).toBe('');
    expect(screen.getByText('sites.stationMessageLanguageDefault')).toBeDefined();
  });

  it('saves a site language', async () => {
    renderTab();
    fireEvent.change(languageSelect(), { target: { value: 'de' } });
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/sites/sit_1', { stationMessageLanguage: 'de' });
    });
  });

  it('clears the site language back to the company default', async () => {
    renderTab({ ...SITE, stationMessageLanguage: 'de' });
    expect(languageSelect().value).toBe('de');
    fireEvent.change(languageSelect(), { target: { value: '' } });
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/sites/sit_1', { stationMessageLanguage: null });
    });
  });
});
