// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, putMock, permissions } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  permissions: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: putMock, patch: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  },
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'USD', isError: false, refetch: vi.fn() }),
}));

// Covered by electricity-cost-notices.test.tsx.
vi.mock('@/components/ElectricityCostNotices', () => ({
  RecalculateElectricityCostAction: () => null,
}));

import { Tabs } from '@/components/ui/tabs';
import { SiteFreeVendTab } from '../site/SiteFreeVendTab';
import { SiteElectricityRatesTab } from '../SiteElectricityRatesTab';
import { SiteLayout } from '../layout/SiteLayout';

function wrap(node: React.ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const FREE_VEND_SITE = {
  id: 'sit_1',
  freeVendEnabled: false,
  freeVendTemplateId21: null,
  freeVendTemplateId16: null,
};

function renderFreeVend(site = FREE_VEND_SITE): void {
  wrap(
    <Tabs value="free-vend" onValueChange={() => undefined}>
      <SiteFreeVendTab site={site} siteId={site.id} />
    </Tabs>,
  );
}

beforeEach(() => {
  permissions.clear();
  getMock.mockResolvedValue([]);
  postMock.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteFreeVendTab', () => {
  it('locks the switch without sites:write', () => {
    renderFreeVend();
    expect(screen.getByLabelText('sites.freeVend')).toHaveProperty('disabled', true);
  });

  it('turns free vend on only after the confirmation', async () => {
    permissions.add('sites:write');
    renderFreeVend();
    fireEvent.click(screen.getByLabelText('sites.freeVend'));
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getByText('sites.confirmEnableFreeVend')).toBeDefined();
    const dialog = screen.getByRole('dialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'sites.enableFreeVend',
    );
    fireEvent.click(confirm as HTMLButtonElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/free-vend', { enabled: true });
    });
  });

  it('asks before turning free vend off', () => {
    permissions.add('sites:write');
    renderFreeVend({ ...FREE_VEND_SITE, freeVendEnabled: true });
    fireEvent.click(screen.getByLabelText('sites.freeVend'));
    expect(screen.getByText('sites.confirmDisableFreeVend')).toBeDefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('links the authorization restore templates once they exist', () => {
    renderFreeVend({
      ...FREE_VEND_SITE,
      freeVendRestoreTemplateId21: 'tpl_r21',
      freeVendRestoreTemplateId16: 'tpl_r16',
    } as typeof FREE_VEND_SITE);
    expect(screen.getByText('sites.freeVendRestoreTitle')).toBeDefined();
    const hrefs = screen
      .getAllByText('sites.freeVendViewTemplate')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/station-configurations/tpl_r21', '/station-configurations/tpl_r16']);
    expect(screen.getByText('sites.freeVendDisabledNote')).toBeDefined();
  });
});

describe('SiteElectricityRatesTab', () => {
  const RATE = { id: 1, siteId: 'sit_1', name: 'Flat', ratePerKwh: 0.12, restrictions: null };

  it('shows the rates without write controls to a reader', async () => {
    getMock.mockResolvedValue([RATE]);
    wrap(<SiteElectricityRatesTab siteId="sit_1" siteName="Main" />);
    expect(await screen.findByText('Flat')).toBeDefined();
    expect(screen.queryByText('sites.addElectricityRate')).toBeNull();
    expect(screen.queryByLabelText('sites.deleteElectricityRate')).toBeNull();
  });

  it('offers the write controls with sites:write', async () => {
    permissions.add('sites:write');
    getMock.mockResolvedValue([RATE]);
    wrap(<SiteElectricityRatesTab siteId="sit_1" siteName="Main" />);
    expect(await screen.findByText('Flat')).toBeDefined();
    expect(screen.getByText('sites.addElectricityRate')).toBeDefined();
    expect(screen.getByLabelText('sites.deleteElectricityRate')).toBeDefined();
  });
});

describe('SiteLayout', () => {
  const STATION = {
    id: 'sta_1',
    stationId: 'CS-1',
    model: null,
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: 0,
    positionY: 0,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: 150,
            status: 'available',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout') ? [STATION] : { config: null, hierarchy: [], stations: [] },
      ),
    );
  });

  it('labels the layout in the user language and hides saving without sites:write', async () => {
    wrap(<SiteLayout siteId="sit_1" />);
    expect(await screen.findByText('sites.stationLayout')).toBeDefined();
    expect(screen.getByText('status.online')).toBeDefined();
    expect(screen.getByText(/stations\.sp1/)).toBeDefined();
    expect(screen.queryByText('common.save')).toBeNull();
  });

  it('shows saving with sites:write', async () => {
    permissions.add('sites:write');
    wrap(<SiteLayout siteId="sit_1" />);
    expect(await screen.findByText('sites.stationLayout')).toBeDefined();
    expect(screen.getByRole('button', { name: /save/i })).toBeDefined();
  });
});
