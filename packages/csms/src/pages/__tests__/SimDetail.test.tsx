// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SIM page: header, the Details tab (CSMS status apart from the provider
// status, Refresh, Network Reset, Edit, Deactivate, Reactivate, Delete), the
// Sessions tab, the Attachments tab and the History tab, each write hidden or
// disabled as its route requires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { apiMock, authState, flagState, toastMock } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    authState: {
      permissions: ['sims:read', 'sims:write', 'stations:write', 'audit:read'],
      allSites: true,
    },
    flagState: { simEnabled: true, isLoading: false },
    toastMock: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
    useHasAllSiteAccess: () => authState.allSites,
    useHasCompanyWidePermission: (perm: string) =>
      authState.allSites && authState.permissions.includes(perm),
  };
});
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: { simEnabled: flagState.simEnabled },
    isLoading: flagState.isLoading,
  }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/entity-nav-buttons', () => ({
  EntityNavButtons: (props: { resource: string; basePath: string; currentId?: string }) => (
    <div
      data-testid="entity-nav"
      data-resource={props.resource}
      data-base={props.basePath}
      data-current={props.currentId}
    />
  ),
}));
vi.mock('@/components/EntityHistoryTab', () => ({
  EntityHistoryTab: (props: { entityType: string; entityId: string | null }) => (
    <div data-testid="entity-history" data-type={props.entityType} data-id={props.entityId} />
  ),
}));

import { SimDetail } from '@/pages/SimDetail';

const ATTACHMENT = {
  id: 7,
  stationId: 'sta_1',
  stationOcppId: 'CS-001',
  siteId: 'sit_1',
  siteName: 'Depot',
  paymentTerminalId: null,
  source: 'reported' as const,
  attachedAt: '2026-10-20T09:00:00.000Z',
  confirmed: false,
  confirmedAt: null,
};

function simDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sim_1',
    iccid: '8944500102198304826',
    imsi: '234500000000001',
    label: 'Depot spare',
    notes: 'In the cabinet',
    provider: 'hologram',
    providerRef: '123456',
    status: 'active',
    deactivatedAt: null,
    deactivatedBy: null,
    deactivatedByUser: null,
    lastStatus: {
      state: 'suspended',
      providerState: 'PAUSED',
      inSession: false,
      openSessionBeganAt: null,
      apn: 'hologram',
      profileName: null,
      lastSessionAt: null,
      usage: null,
    },
    statusFetchedAt: '2026-10-21T10:00:00.000Z',
    lastFetchedAt: '2026-10-21T10:00:00.000Z',
    lookupMissedAt: null,
    lookupMissReason: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    attachment: ATTACHMENT,
    attachedBy: null,
    capabilities: {
      networkName: true,
      radioAccessTechnology: true,
      cellId: true,
      usage: true,
      sessions: true,
      alerts: true,
      networkReset: true,
    },
    network: null,
    recentAlerts: [],
    historyDays: 31,
    reportingDelayHours: null,
    fetchDays: 7,
    retentionDays: 90,
    coverageTimeZone: 'UTC',
    ...overrides,
  };
}

const HISTORY = {
  data: [
    {
      ...ATTACHMENT,
      attachedBy: null,
      confirmedBy: null,
      detachedAt: null,
      detachedBy: null,
      detachReason: null,
    },
    {
      id: 3,
      stationId: 'sta_2',
      stationOcppId: 'CS-002',
      siteId: null,
      siteName: null,
      paymentTerminalId: null,
      source: 'entered',
      attachedAt: '2026-09-01T09:00:00.000Z',
      attachedBy: { id: 'usr_1', name: 'Ada Admin' },
      confirmedAt: '2026-09-01T09:00:00.000Z',
      confirmedBy: 'usr_1',
      detachedAt: '2026-10-01T09:00:00.000Z',
      detachedBy: 'usr_1',
      detachReason: 'iccid_changed',
    },
  ],
  total: 2,
};

let detail: Record<string, unknown> = simDetail();

function routeGet(url: string): Promise<unknown> {
  if (url === '/v1/sims/sim_1') return Promise.resolve(detail);
  if (url.startsWith('/v1/sims/sim_1/attachments')) return Promise.resolve(HISTORY);
  if (url.startsWith('/v1/sims/sim_1/timeline')) {
    return Promise.resolve({
      items: [],
      nextCursor: null,
      from: '2026-10-21T00:00:00.000Z',
      to: '2026-10-22T00:00:00.000Z',
      capped: false,
      lastFetchedAt: null,
      days: [],
    });
  }
  if (url.startsWith('/v1/stations?')) {
    return Promise.resolve({ data: [{ id: 'sta_9', stationId: 'CS-009', isOnline: true }] });
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

let client: QueryClient;

function renderPage(path = '/sims/sim_1'): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sims/:id" element={<SimDetail />} />
          <Route path="/sims" element={<p>sims list</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  detail = simDetail();
  authState.permissions = ['sims:read', 'sims:write', 'stations:write', 'audit:read'];
  authState.allSites = true;
  flagState.simEnabled = true;
  flagState.isLoading = false;
  apiMock.get.mockImplementation(routeGet);
  apiMock.post.mockResolvedValue({});
  apiMock.patch.mockResolvedValue({});
  apiMock.delete.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SimDetail page states', () => {
  it('shows the feature-off notice while the SIM features are off and reads nothing', () => {
    flagState.simEnabled = false;
    renderPage();
    expect(screen.getByText('sims.featureOff')).toBeDefined();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('shows the loading logo while the SIM loads', () => {
    apiMock.get.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('shows the load error with Retry, and Retry reads again', async () => {
    let calls = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/v1/sims/sim_1') {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(detail);
      }
      return routeGet(url);
    });
    renderPage();
    expect(await screen.findByText('common.loadError')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByRole('heading', { name: 'Depot spare' })).toBeDefined();
  });

  it('says the SIM was not found on a 404', async () => {
    const { ApiError } = await import('@/lib/api');
    apiMock.get.mockImplementation((url: string) =>
      url === '/v1/sims/sim_1'
        ? Promise.reject(new ApiError(404, { error: 'SIM not found', code: 'SIM_NOT_FOUND' }))
        : routeGet(url),
    );
    renderPage();
    expect(await screen.findByText('sims.detail.notFound')).toBeDefined();
  });
});

describe('SimDetail header', () => {
  it('shows the label, the copyable id and Prev and Next over the SIM list', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Depot spare' })).toBeDefined();
    expect(screen.getByText('sim_1')).toBeDefined();
    const nav = screen.getByTestId('entity-nav');
    expect(nav.getAttribute('data-resource')).toBe('sims');
    expect(nav.getAttribute('data-base')).toBe('/sims');
    expect(nav.getAttribute('data-current')).toBe('sim_1');
  });

  it('shows the ICCID as the title when the SIM has no label', async () => {
    detail = simDetail({ label: null });
    renderPage();
    expect(await screen.findByRole('heading', { name: '8944500102198304826' })).toBeDefined();
  });
});

describe('SimDetail Details tab', () => {
  it('shows the CSMS status and the provider status with distinct labels', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    expect(screen.getByText('sims.detail.csmsStatus')).toBeDefined();
    expect(screen.getByText('sims.detail.providerStatus')).toBeDefined();
    expect(screen.getByText('sims.csmsStatus.active')).toBeDefined();
    expect(screen.getByText('stations.sim.state.suspended')).toBeDefined();
  });

  it('shows the ICCID, IMSI and provider id as copyable ids', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const ids = screen.getAllByTestId('id-text').map((el) => el.textContent);
    expect(ids).toEqual(
      expect.arrayContaining(['8944500102198304826', '234500000000001', '123456']),
    );
  });

  it('refreshes the SIM for the chosen period and shows the provider line only', async () => {
    apiMock.post.mockResolvedValueOnce({ provider: { result: 'ok', sessionsStored: 2 } });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.click(screen.getByRole('button', { name: 'stations.sim.refresh' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/refresh', { days: 7 });
    });
    const result = await screen.findByTestId('sim-refresh-result');
    expect(result.querySelectorAll('li')).toHaveLength(1);
  });

  it('disables Refresh, Network Reset and Attach with the reason while the SIM is inactive', async () => {
    detail = simDetail({ status: 'inactive', attachment: null });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const refresh = screen.getByRole('button', { name: 'stations.sim.refresh' });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sim-refresh-disabled').textContent).toContain(
      'sims.detail.inactiveReason',
    );
    const reset = screen.getByRole('button', { name: 'stations.sim.resetNetwork' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'sims.detail.tabs.attachments' }));
    const attach = await screen.findByRole('button', { name: 'sims.detail.attachments.attach' });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets the network after the confirmation', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.click(screen.getByRole('button', { name: 'stations.sim.resetNetwork' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.resetNetwork' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/network-reset', {});
    });
  });

  it('deactivates the SIM after the confirmation', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.deactivate' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.deactivate' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/deactivate', {});
    });
  });

  it('reactivates an inactive SIM after the confirmation', async () => {
    detail = simDetail({ status: 'inactive', attachment: null });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    expect(screen.queryByRole('button', { name: 'sims.detail.deactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.reactivate' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.reactivate' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/reactivate', {});
    });
  });

  it('disables Delete with the reason while the SIM is attached', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const del = screen.getByRole('button', { name: 'sims.detail.delete' });
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sim-delete-disabled').textContent).toContain(
      'sims.detail.deleteAttachedReason',
    );
  });

  it('deletes an unattached SIM after the confirmation and opens the SIM list', async () => {
    detail = simDetail({ attachment: null });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.delete' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.delete' }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/sims/sim_1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/sims');
    });
  });

  it('hides every write without sims:write', async () => {
    authState.permissions = ['sims:read'];
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    for (const name of [
      'sims.detail.deactivate',
      'sims.detail.delete',
      'stations.sim.resetNetwork',
      'common.save',
    ]) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    // Refresh needs sims:read only.
    expect(screen.getByRole('button', { name: 'stations.sim.refresh' })).toBeDefined();
  });

  it('hides Deactivate and Delete from a site-restricted user, keeping Edit and Reset', async () => {
    authState.allSites = false;
    detail = simDetail({ attachment: { ...ATTACHMENT, confirmed: true } });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    expect(screen.queryByRole('button', { name: 'sims.detail.deactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sims.detail.delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'stations.sim.resetNetwork' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDefined();
  });
});

describe('SimDetail Edit form', () => {
  it('disables Save until a value changes, and again once it is changed back', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const save = screen.getByRole('button', { name: 'common.save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const label = screen.getByLabelText('sims.detail.label');
    const loaded = (label as HTMLInputElement).value;
    fireEvent.change(label, { target: { value: `${loaded} 2` } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(label, { target: { value: loaded } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Save enabled with invalid values, shows field errors only after a submit, and sends nothing then', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const imsi = screen.getByLabelText('sims.detail.imsi');
    fireEvent.change(imsi, { target: { value: '12ab' } });
    expect(screen.queryByText('sims.detail.imsiInvalid')).toBeNull();
    expect(screen.getByText('settings.unsavedChanges')).toBeDefined();
    const save = screen.getByRole('button', { name: 'common.save' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText('sims.detail.imsiInvalid')).toBeDefined();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('saves the label, notes and IMSI, an emptied field as null', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.change(screen.getByLabelText('sims.detail.label'), { target: { value: 'Spare 2' } });
    fireEvent.change(screen.getByLabelText('sims.detail.notes'), { target: { value: '' } });
    const form = screen.getByLabelText('sims.detail.label').closest('form');
    expect(form?.noValidate).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sims/sim_1', {
        label: 'Spare 2',
        notes: null,
        imsi: '234500000000001',
      });
    });
  });
});

describe('SimDetail Edit form, trimmed values', () => {
  it('shows Saved, not Unsaved Changes, after saving a value with a trailing space', async () => {
    let saved = detail;
    apiMock.get.mockImplementation((url: string) =>
      url === '/v1/sims/sim_1' ? Promise.resolve(saved) : routeGet(url),
    );
    apiMock.patch.mockImplementation((_url: string, body: Record<string, unknown>) => {
      saved = { ...saved, ...body };
      return Promise.resolve(saved);
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.change(screen.getByLabelText('sims.detail.label'), {
      target: { value: 'Depot 3 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        '/v1/sims/sim_1',
        expect.objectContaining({ label: 'Depot 3' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
    });
    const save = screen.getByRole('button', { name: 'common.save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('treats a value that differs only by spaces as unchanged', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    fireEvent.change(screen.getByLabelText('sims.detail.label'), {
      target: { value: ' Depot spare ' },
    });
    expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
    const save = screen.getByRole('button', { name: 'common.save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SimDetail Sessions tab', () => {
  it('reads the SIM timeline', async () => {
    renderPage('/sims/sim_1?tab=sessions');
    await screen.findByRole('heading', { name: 'Depot spare' });
    await waitFor(() => {
      expect(
        apiMock.get.mock.calls.some(([url]) =>
          String(url).startsWith('/v1/sims/sim_1/timeline?from='),
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('stations.sim.timelineEmpty')).toBeDefined();
  });
});

describe('SimDetail inactive SIM timeline', () => {
  it('disables the Fetch rows and the day clicks with the reason while the SIM is inactive', async () => {
    detail = simDetail({ status: 'inactive', attachment: null });
    apiMock.get.mockImplementation((url: string) =>
      url.startsWith('/v1/sims/sim_1/timeline')
        ? Promise.resolve({
            items: [],
            nextCursor: null,
            from: '2026-10-21T00:00:00.000Z',
            to: '2026-10-22T00:00:00.000Z',
            capped: false,
            lastFetchedAt: null,
            days: [{ date: '2026-10-21', label: 'not_fetched' }],
          })
        : routeGet(url),
    );
    renderPage('/sims/sim_1?tab=sessions');
    const gap = await screen.findByTestId('sim-timeline-gap');
    const fetch = within(gap).getByRole('button', { name: 'stations.sim.fetch' });
    expect((fetch as HTMLButtonElement).disabled).toBe(true);
    expect(gap.textContent).toContain('sims.detail.inactiveReason');
    const day = screen.getByTestId('sim-coverage-day-2026-10-21');
    const dayButton = within(day).getByRole('button');
    expect((dayButton as HTMLButtonElement).disabled).toBe(true);
    expect(day.textContent).toContain('sims.detail.inactiveReason');
    fireEvent.click(fetch);
    fireEvent.click(dayButton);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SimDetail no recent alerts', () => {
  it('says no SIM alerts are stored for this SIM, not for a station', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    expect(screen.getByText('sims.detail.noRecentAlerts')).toBeDefined();
    expect(screen.queryByText('stations.sim.noRecentAlerts')).toBeNull();
  });
});

describe('SimDetail Attachments tab', () => {
  it('shows the current attachment with its source in plain words, and Confirm and Detach', async () => {
    renderPage('/sims/sim_1?tab=attachments');
    const card = await screen.findByTestId('sim-current-attachment');
    expect(within(card).getByText('CS-001')).toBeDefined();
    expect(within(card).getByText('sims.detail.attachments.sourceLabel.reported')).toBeDefined();
    fireEvent.click(within(card).getByRole('button', { name: 'stations.sim.confirmSim' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.confirmSim' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/attachments/7/confirm', {});
    });
    fireEvent.click(within(card).getByRole('button', { name: 'sims.detail.attachments.detach' }));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.attachments.detach' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/attachments/7/detach', {});
    });
  });

  it('lists the past attachments with their station, source and reason', async () => {
    renderPage('/sims/sim_1?tab=attachments');
    const row = await screen.findByTestId('sim-attachment-row-3');
    expect(within(row).getByText('CS-002')).toBeDefined();
    expect(within(row).getByText('sims.detail.attachments.sourceLabel.entered')).toBeDefined();
    expect(within(row).getByText('sims.detail.attachments.reason.iccidChanged')).toBeDefined();
  });

  it('attaches an unattached SIM to the station picked in the dialog', async () => {
    detail = simDetail({ attachment: null });
    apiMock.post.mockResolvedValueOnce({ ...ATTACHMENT, stationOcppId: 'CS-009' });
    renderPage('/sims/sim_1?tab=attachments');
    expect(await screen.findByText('sims.detail.attachments.notAttached')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.attachments.attach' }));
    const dialog = screen.getByRole('dialog');
    // Submitting without a station shows the field error and sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.attachments.attach' }));
    expect(await within(dialog).findByText('validation.selectRequired')).toBeDefined();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('sims.detail.attachments.station'), {
      target: { value: 'CS' },
    });
    fireEvent.click(await within(dialog).findByText('CS-009'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.attachments.attach' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sims/sim_1/attachments', {
        stationId: 'sta_9',
      });
    });
  });

  it('hides Attach and Confirm without stations:write, keeping Detach', async () => {
    authState.permissions = ['sims:read', 'sims:write'];
    renderPage('/sims/sim_1?tab=attachments');
    const card = await screen.findByTestId('sim-current-attachment');
    expect(within(card).queryByRole('button', { name: 'stations.sim.confirmSim' })).toBeNull();
    expect(
      within(card).getByRole('button', { name: 'sims.detail.attachments.detach' }),
    ).toBeDefined();
  });
});

describe('SimDetail station tab freshness', () => {
  // The station Connectivity tab keeps its SIM data until it is invalidated:
  // every change of the SIM's attachment on the SIM page reloads it.
  function stationSimInvalidated(spy: { mock: { calls: unknown[][] } }): boolean {
    return spy.mock.calls.some(
      ([filters]) =>
        JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey) ===
        JSON.stringify(['station-sim']),
    );
  }

  it('reloads the station SIM data after Confirm and Detach', async () => {
    renderPage('/sims/sim_1?tab=attachments');
    const card = await screen.findByTestId('sim-current-attachment');
    const spy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(within(card).getByRole('button', { name: 'stations.sim.confirmSim' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'stations.sim.confirmSim' }),
    );
    await waitFor(() => {
      expect(stationSimInvalidated(spy)).toBe(true);
    });
    spy.mockClear();
    fireEvent.click(within(card).getByRole('button', { name: 'sims.detail.attachments.detach' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'sims.detail.attachments.detach',
      }),
    );
    await waitFor(() => {
      expect(stationSimInvalidated(spy)).toBe(true);
    });
  });

  it('reloads the station SIM data after Attach', async () => {
    detail = simDetail({ attachment: null });
    apiMock.post.mockResolvedValueOnce({ ...ATTACHMENT, stationOcppId: 'CS-009' });
    renderPage('/sims/sim_1?tab=attachments');
    await screen.findByText('sims.detail.attachments.notAttached');
    const spy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.attachments.attach' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('sims.detail.attachments.station'), {
      target: { value: 'CS' },
    });
    fireEvent.click(await within(dialog).findByText('CS-009'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'sims.detail.attachments.attach' }));
    await waitFor(() => {
      expect(stationSimInvalidated(spy)).toBe(true);
    });
  });

  it('reloads the station SIM data after Deactivate and Delete', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const spy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.deactivate' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'sims.detail.deactivate' }),
    );
    await waitFor(() => {
      expect(stationSimInvalidated(spy)).toBe(true);
    });
    cleanup();
    detail = simDetail({ attachment: null });
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    const deleteSpy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'sims.detail.delete' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'sims.detail.delete' }),
    );
    await waitFor(() => {
      expect(stationSimInvalidated(deleteSpy)).toBe(true);
    });
  });
});

describe('SimDetail History tab', () => {
  it('shows the SIM audit history with audit:read', async () => {
    renderPage('/sims/sim_1?tab=history');
    const history = await screen.findByTestId('entity-history');
    expect(history.getAttribute('data-type')).toBe('sim');
    expect(history.getAttribute('data-id')).toBe('sim_1');
  });

  it('has no History tab without audit:read', async () => {
    authState.permissions = ['sims:read'];
    renderPage();
    await screen.findByRole('heading', { name: 'Depot spare' });
    expect(screen.queryByRole('tab', { name: 'sims.detail.tabs.history' })).toBeNull();
  });
});
