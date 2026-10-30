// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, permissions, webgl, sceneProps } = vi.hoisted(() => ({
  getMock: vi.fn(),
  permissions: new Set<string>(),
  webgl: { available: true },
  sceneProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'name' in opts ? `${key}:${String(opts['name'])}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

vi.mock('@/lib/webgl', () => ({
  webglAvailable: () => webgl.available,
}));

// three.js does not run in jsdom: the 3D view is a stub that records its props.
vi.mock('@/components/layout/SiteLayout3D', () => ({
  default: (props: Record<string, unknown>) => {
    sceneProps.push(props);
    return <div data-testid="site-layout-3d-stub" />;
  },
}));

import { SiteLayoutWidget, defaultLayoutSite } from '../SiteLayoutWidget';

const SITES = [
  { id: 'sit_empty', name: 'Empty Lot', stationCount: 0 },
  { id: 'sit_main', name: 'Main Street', stationCount: 2 },
  { id: 'sit_depot', name: 'Depot', stationCount: 4 },
];

function station(id: string) {
  return {
    id,
    stationId: id.toUpperCase(),
    model: 'Terra 184',
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [],
  };
}

function mockApi(): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/sites?limit=100') return Promise.resolve({ data: SITES, total: 3 });
    if (url === '/v1/portal/branding') return Promise.resolve({});
    const site = /^\/v1\/sites\/([^/]+)$/.exec(url);
    if (site != null) {
      const found = SITES.find((s) => s.id === site[1]);
      return Promise.resolve({ name: found?.name ?? 'Far Away', layoutSettings: null });
    }
    if (/\/v1\/sites\/[^/]+\/layout$/.test(url)) {
      return Promise.resolve([station('sta_1'), station('sta_2')]);
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderWidget(props: Partial<{ siteId: string | null; siteUnavailable: boolean }> = {}): {
  onSiteChange: ReturnType<typeof vi.fn>;
} {
  const onSiteChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SiteLayoutWidget
          siteId={props.siteId ?? null}
          siteUnavailable={props.siteUnavailable ?? false}
          onSiteChange={onSiteChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSiteChange };
}

beforeEach(() => {
  mockApi();
  permissions.add('sites:read');
});

afterEach(() => {
  cleanup();
  permissions.clear();
  sceneProps.length = 0;
  webgl.available = true;
  vi.clearAllMocks();
});

describe('SiteLayoutWidget', () => {
  it('picks the first accessible site with stations by default', () => {
    expect(defaultLayoutSite(SITES)?.id).toBe('sit_main');
    expect(defaultLayoutSite(SITES.slice(0, 1))?.id).toBe('sit_empty');
    expect(defaultLayoutSite([])).toBeUndefined();
  });

  it('shows the default site view only, with the site picker and a link to its Layout tab', async () => {
    renderWidget();
    await screen.findByTestId('site-layout-3d-stub');

    const select = screen.getByLabelText<HTMLSelectElement>('dashboard.siteLayout.siteLabel');
    expect(select.value).toBe('sit_main');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Empty Lot',
      'Main Street',
      'Depot',
    ]);
    expect(
      screen.getByRole('link', { name: /dashboard.siteLayout.openLayout/ }).getAttribute('href'),
    ).toBe('/sites/sit_main?tab=layout');

    // View only: no edit controls, the front camera, the widget stage.
    const props = sceneProps.at(-1) ?? {};
    expect(props['editing']).toBe(false);
    expect(props['viewOnly']).toBe(true);
    expect(props['cameraView']).toBe('front');
    expect(props['stageClassName']).toBe('h-[360px] sm:h-[460px]');
    expect(screen.queryByText('sites.layoutView.editLayout')).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(getMock).toHaveBeenCalledWith('/v1/sites/sit_main/layout');
    // Load management is read only with its permission.
    expect(getMock).not.toHaveBeenCalledWith('/v1/sites/sit_main/load-management');
  });

  it('shows the chosen site and saves another pick', async () => {
    const { onSiteChange } = renderWidget({ siteId: 'sit_depot' });
    await screen.findByTestId('site-layout-3d-stub');
    expect(
      screen.getByRole('link', { name: /dashboard.siteLayout.openLayout/ }).getAttribute('href'),
    ).toBe('/sites/sit_depot?tab=layout');

    fireEvent.change(screen.getByLabelText('dashboard.siteLayout.siteLabel'), {
      target: { value: 'sit_empty' },
    });
    expect(onSiteChange).toHaveBeenCalledWith('sit_empty');
  });

  it('lists a chosen site past the first page under its own name', async () => {
    renderWidget({ siteId: 'sit_far' });
    await screen.findByTestId('site-layout-3d-stub');
    const select = screen.getByLabelText<HTMLSelectElement>('dashboard.siteLayout.siteLabel');
    await waitFor(() => {
      expect([...select.options].at(-1)?.textContent).toBe('Far Away');
    });
    expect(select.value).toBe('sit_far');
  });

  it('says quietly that a chosen site is gone and shows the default one', async () => {
    renderWidget({ siteId: null, siteUnavailable: true });
    expect(
      await screen.findByText('dashboard.siteLayout.siteUnavailable:Main Street'),
    ).toBeTruthy();
    await screen.findByTestId('site-layout-3d-stub');
  });

  it('resets the view with Reset View', async () => {
    renderWidget();
    await screen.findByTestId('site-layout-3d-stub');
    expect(sceneProps.at(-1)?.['fitKey']).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /dashboard.siteLayout.resetView/ }));
    expect(sceneProps.at(-1)?.['fitKey']).toBe(1);
  });

  it('shows a note and no 3D view without WebGL', async () => {
    webgl.available = false;
    renderWidget();
    expect(await screen.findByTestId('site-layout-widget-webgl-note')).toBeTruthy();
    expect(screen.queryByTestId('site-layout-3d-stub')).toBeNull();
    expect(screen.queryByRole('button', { name: /dashboard.siteLayout.resetView/ })).toBeNull();
  });

  it('polls load management only with its permission', async () => {
    permissions.add('loadManagement:read');
    renderWidget();
    await screen.findByTestId('site-layout-3d-stub');
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/sites/sit_main/load-management');
    });
  });

  it('says so when the user has no site', async () => {
    getMock.mockImplementation((url: string) =>
      url === '/v1/sites?limit=100'
        ? Promise.resolve({ data: [], total: 0 })
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    renderWidget();
    expect(await screen.findByText('dashboard.siteLayout.noSites')).toBeTruthy();
    expect(screen.queryByLabelText('dashboard.siteLayout.siteLabel')).toBeNull();
  });
});

// The dashboard chunk must not carry three.js: only SiteLayout3D (loaded
// with React.lazy) imports the scene, and nothing on the dashboard imports
// SiteLayout3D or three statically.
const SOURCES = import.meta.glob<string>(
  [
    '../../../pages/Dashboard.tsx',
    '../SiteLayoutWidget.tsx',
    '../../layout/site-layout-data.ts',
    '../../../hooks/use-dashboard-layout.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

describe('dashboard bundle split', () => {
  it('keeps three.js and the 3D scene out of the dashboard entry', () => {
    expect(Object.keys(SOURCES)).toHaveLength(4);
    for (const [file, source] of Object.entries(SOURCES)) {
      expect(source, file).not.toMatch(/from ['"]three(\/|['"])/);
      expect(source, file).not.toMatch(/site-layout-scene/);
      expect(source, file).not.toMatch(/import [^;]*from ['"][^'"]*SiteLayout3D['"]/);
    }
    expect(SOURCES['../SiteLayoutWidget.tsx']).toMatch(
      /lazy\(\(\) => import\('@\/components\/layout\/SiteLayout3D'\)\)/,
    );
  });
});
