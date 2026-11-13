// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, patchMock, putMock, permissions } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
  permissions: new Set<string>(['sites:write']),
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, patch: patchMock, put: putMock },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  },
}));

vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));
// Covered by its own test (SiteAiCard.test.tsx).
vi.mock('@/components/ai/usage/SiteAiCard', () => ({ SiteAiCard: () => null }));
vi.mock('@/lib/timezone', () => ({
  TIMEZONE_OPTIONS: [],
  formatDateTime: (value: string) => `date:${value}`,
}));

import { Tabs } from '@/components/ui/tabs';
import type { SiteLayoutSettings } from '@evtivity/lib/site-layout';
import { SiteDetailsTab, type SiteDetailsTabProps } from '../site/SiteDetailsTab';

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
  contactEmail: null as string | null,
  contactPhone: null as string | null,
  contactIsPublic: false,
  hoursOfOperation: null,
  reservationsEnabled: true,
  freeVendEnabled: false,
  freeVendTemplateId21: null,
  freeVendTemplateId16: null,
  carbonRegionCode: null,
  stationMessageLanguage: null as string | null,
  stationCount: 0,
  layoutSettings: null as SiteLayoutSettings | null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function renderTab(
  site: SiteDetailsTabProps['site'] = SITE,
  options: { onDelete?: () => void; deleteError?: unknown } = {},
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Tabs value="details" onValueChange={() => undefined}>
          <SiteDetailsTab
            site={site}
            siteId={site.id}
            googleMapsApiKey=""
            onDelete={options.onDelete ?? (() => undefined)}
            deleteIsPending={false}
            deleteError={options.deleteError}
          />
        </Tabs>
      </MemoryRouter>
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

describe('SiteDetailsTab writes', () => {
  beforeEach(() => {
    getMock.mockResolvedValue([]);
    patchMock.mockResolvedValue({});
    permissions.clear();
    permissions.add('sites:write');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('hides edit and delete and locks the selects without sites:write', () => {
    permissions.clear();
    renderTab();
    expect(screen.queryByText('common.edit')).toBeNull();
    expect(screen.queryByText('common.delete')).toBeNull();
    expect(languageSelect().disabled).toBe(true);
  });

  it('leaves Autocharge, Data Plan and Carbon Region to their own tabs', () => {
    renderTab();
    expect(screen.queryByLabelText('sites.autocharge')).toBeNull();
    expect(screen.queryByText('dataPlan.title')).toBeNull();
    expect(screen.queryByLabelText('sites.carbonRegion')).toBeNull();
  });

  it('sends null for a field the operator emptied', async () => {
    renderTab({ ...SITE, contactEmail: 'ops@example.com', contactPhone: '555' });
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('sites.contactEmail'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('sites.contactPhone'), { target: { value: ' ' } });
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/sites/sit_1',
        expect.objectContaining({ contactEmail: null, contactPhone: null, address: null }),
      );
    });
  });

  it('shows why a save failed', async () => {
    const { ApiError } = await import('@/lib/api');
    patchMock.mockRejectedValueOnce(
      new ApiError(409, {
        code: 'DUPLICATE_SITE_NAME',
        error: 'A site with this name already exists',
      }),
    );
    renderTab();
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    expect(await screen.findByText('A site with this name already exists')).toBeDefined();
  });

  it('deletes only after the confirmation and shows a refusal', () => {
    const onDelete = vi.fn();
    renderTab(SITE, {
      onDelete,
      deleteError: { status: 409 },
    });
    fireEvent.click(screen.getByText('common.delete'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('sites.deleteSiteTitle')).toBeDefined();
    const dialog = screen.getByRole('dialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'common.delete',
    );
    fireEvent.click(confirm as HTMLButtonElement);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByText('errors.unknown')).toBeDefined();
  });
});

describe('SiteDetailsTab site type and layout summary', () => {
  const BASE: SiteLayoutSettings = {
    spotsPerRow: 10,
    rows: 2,
    facingDeg: 0,
    transformers: [{ id: 'tx-1', x: 30, z: -3 }],
  };
  // Two transformers of the site, one without a stored position: both count.
  const EQUIPMENT = {
    transformers: [
      { id: 'tx-1', kind: 'service' as const, name: 'A', ratedKva: 1000, maxContinuousKw: 950 },
      { id: 'tx-2', kind: 'service' as const, name: 'B', ratedKva: null, maxContinuousKw: null },
    ],
    energyAssets: [],
  };

  beforeEach(() => {
    getMock.mockResolvedValue([]);
    patchMock.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('summarizes a parking lot with its transformers and links to the Layout tab', () => {
    renderTab({ ...SITE, layoutSettings: BASE, powerEquipment: EQUIPMENT });
    expect(screen.getByTestId('site-type-value').textContent).toBe(
      'sites.layoutSettings.siteTypeParkingLot',
    );
    const link = screen.getByTestId('site-layout-summary');
    expect(link.textContent).toBe(
      'sites.layoutSummary.parkingLotTransformers:{"rows":2,"spots":10,"count":2}',
    );
    expect(link.getAttribute('href')).toBe('/sites/sit_1?tab=layout');
  });

  it('summarizes the lot without equipment when the site carries none (no loadManagement:read)', () => {
    renderTab({ ...SITE, layoutSettings: BASE });
    const link = screen.getByTestId('site-layout-summary');
    expect(link.textContent).toContain('"rows":2,"spots":10');
    expect(link.textContent).not.toContain('Transformers');
  });

  it('summarizes an office or retail site by its mounting and a curbside site by its sides', () => {
    renderTab({
      ...SITE,
      layoutSettings: { ...BASE, siteType: 'office_retail', chargers: 12, mounting: 'wall' },
    });
    expect(screen.getByTestId('site-layout-summary').textContent).toBe(
      'sites.layoutSummary.officeWall:{"count":12}',
    );
    cleanup();
    renderTab({
      ...SITE,
      layoutSettings: { ...BASE, siteType: 'office_retail', chargers: 6, mounting: 'stall' },
    });
    expect(screen.getByTestId('site-layout-summary').textContent).toBe(
      'sites.layoutSummary.officeStall:{"count":6}',
    );
    cleanup();
    renderTab({
      ...SITE,
      layoutSettings: { ...BASE, siteType: 'curbside', chargersLeft: 4, chargersRight: 6 },
    });
    expect(screen.getByTestId('site-type-value').textContent).toBe(
      'sites.layoutSettings.siteTypeCurbside',
    );
    expect(screen.getByTestId('site-layout-summary').textContent).toBe(
      'sites.layoutSummary.curbside:{"left":4,"right":6}',
    );
  });

  it('defaults a site that never saved a layout to a parking lot of 2 x 10 spots', () => {
    renderTab();
    expect(screen.getByTestId('site-layout-summary').textContent).toContain('"rows":2,"spots":10');
  });

  it('sends the site type only when it changed', async () => {
    renderTab({ ...SITE, layoutSettings: BASE, powerEquipment: EQUIPMENT });
    fireEvent.click(screen.getByText('common.edit'));
    const select = screen.getByLabelText('sites.layoutSettings.siteType');
    expect((select as HTMLSelectElement).value).toBe('parking_lot');
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'parking_lot',
      'office_retail',
      'curbside',
      'depot',
      'custom',
    ]);
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    expect(patchMock.mock.calls[0]?.[1]).not.toHaveProperty('siteType');
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.siteType'), {
      target: { value: 'curbside' },
    });
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenLastCalledWith(
        '/v1/sites/sit_1',
        expect.objectContaining({ siteType: 'curbside' }),
      );
    });
  });
});
