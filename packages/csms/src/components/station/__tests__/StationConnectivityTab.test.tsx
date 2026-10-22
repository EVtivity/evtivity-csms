// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms, access, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  perms: new Set<string>(),
  access: { allSites: true },
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key.startsWith('errors.')
        ? `tr:${key}`
        : opts == null
          ? key
          : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasAllSiteAccess: () => access.allSites,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { StationConnectivityTab } from '../StationConnectivityTab';
import { zonedDate, type StationSimStatus } from '../sim-connectivity';

const DAY = 86_400_000;
const dayOffset = (days: number): string => zonedDate(new Date(Date.now() - days * DAY), 'UTC');

const MATCHED: StationSimStatus = {
  provider: 'hologram',
  reason: null,
  capabilities: {
    networkName: true,
    radioAccessTechnology: true,
    cellId: false,
    usage: true,
    sessions: true,
    alerts: true,
    networkReset: true,
  },
  status: {
    state: 'active',
    providerState: 'LIVE',
    inSession: false,
    openSessionBeganAt: null,
    apn: 'hologram',
    profileName: 'Global',
    lastSessionAt: '2026-10-20T10:00:00Z',
    usage: { bytes: 1024, periodEnd: '2026-10-31T00:00:00Z', limitBytes: null },
  },
  statusFetchedAt: '2026-10-21T10:00:00Z',
  network: { name: 'T-Mobile', radioAccessTechnology: 'LTE', cellId: null, observedAt: 'x' },
  match: {
    confirmed: true,
    confirmedAt: '2026-10-21T10:00:00Z',
    matchedAt: '2026-10-21T09:00:00.000Z',
    iccidSource: 'entered',
    enteredBy: { id: 'usr_1', name: 'Ada Admin' },
  },
  lastFetchedAt: '2026-10-21T10:00:00Z',
  station: null,
  coverageTimeZone: 'UTC',
  historyDays: 90,
  reportingDelayHours: 6,
  fetchDays: 7,
  retentionDays: 90,
};

const UNCONFIRMED: NonNullable<StationSimStatus['match']> = {
  confirmed: false,
  confirmedAt: null,
  matchedAt: '2026-10-21T09:30:00.000Z',
  iccidSource: 'station',
  enteredBy: null,
};

/** A match nothing was fetched for yet: the provider part waits for Confirm SIM. */
const UNCONFIRMED_SIM: Partial<StationSimStatus> = {
  match: UNCONFIRMED,
  status: null,
  statusFetchedAt: null,
  network: null,
  lastFetchedAt: null,
  recentAlerts: [],
};

const EMPTY_TIMELINE = {
  items: [],
  nextCursor: null,
  from: '2026-10-21T00:00:00Z',
  to: '2026-10-22T00:00:00Z',
  capped: false,
  lastFetchedAt: null,
  days: [],
};

let timeline: Record<string, unknown> = EMPTY_TIMELINE;

function renderTab(
  sim: Partial<StationSimStatus> = {},
  iccid: string | null = '8901',
  stationSignalEnabled = false,
): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/stations/st1/sim') return Promise.resolve({ ...MATCHED, ...sim });
    if (url.startsWith('/v1/stations/st1/sim/timeline')) return Promise.resolve(timeline);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StationConnectivityTab
          stationId="st1"
          iccid={iccid}
          timezone="UTC"
          stationSignalEnabled={stationSignalEnabled}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getCalls(): string[] {
  return apiMock.get.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  perms.clear();
  perms.add('stations:read');
  perms.add('stations:write');
  perms.add('settings.integrations:read');
  access.allSites = true;
  timeline = EMPTY_TIMELINE;
  apiMock.post.mockResolvedValue({
    provider: { result: 'ok', sessionsStored: 12, alertsStored: 1 },
    station: { result: 'skipped', reason: 'signal_off' },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationConnectivityTab', () => {
  it('reads the stored status and timeline only, and never refetches on focus', async () => {
    renderTab();
    expect(await screen.findByText('stations.sim.fromProviderTitle')).toBeTruthy();
    await waitFor(() => {
      expect(getCalls().some((u) => u.startsWith('/v1/stations/st1/sim/timeline'))).toBe(true);
    });
    expect(getCalls().every((u) => u.startsWith('/v1/stations/st1/sim'))).toBe(true);
    expect(apiMock.post).not.toHaveBeenCalled();
    const before = apiMock.get.mock.calls.length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(apiMock.get.mock.calls.length).toBe(before);
    focusManager.setFocused(undefined);
  });

  it('preselects the default period and offers 1, 3, 7, 14 and 31 days and Custom Range', async () => {
    renderTab();
    const select = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    expect(select.value).toBe('7');
    expect([...select.options].map((o) => o.value)).toEqual(['1', '3', '7', '14', '31']);
    expect(screen.getByRole('button', { name: 'stations.sim.customRange' })).toBeTruthy();
  });

  it('never opens the date dialog while the period select changes', async () => {
    renderTab();
    const select = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    for (const value of ['14', '31', '1']) fireEvent.change(select, { target: { value } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(select.value).toBe('1');
  });

  it('preselects the largest period the window allows when the default reaches past it', async () => {
    renderTab({ fetchDays: 31, historyDays: 90, retentionDays: 14 });
    const select = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    expect(select.value).toBe('14');
  });

  it('says what a Refresh calls, by whether station signal reads are on', async () => {
    renderTab();
    expect(await screen.findByText('stations.sim.refreshHintProviderOnly')).toBeTruthy();
    expect(screen.queryByText('stations.sim.refreshHint')).toBeNull();
    cleanup();
    renderTab({}, '8901', true);
    expect(await screen.findByText('stations.sim.refreshHint')).toBeTruthy();
    expect(screen.queryByText('stations.sim.refreshHintProviderOnly')).toBeNull();
  });

  it('disables periods beyond the history window or the retention with the reason', async () => {
    renderTab({ historyDays: 10, retentionDays: 90 });
    const select = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    const option = (v: string) => [...select.options].find((o) => o.value === v);
    expect(option('7')?.disabled).toBe(false);
    expect(option('14')?.disabled).toBe(true);
    expect(option('14')?.title).toContain('stations.sim.periodBeyondHistory');
    cleanup();
    renderTab({ historyDays: 90, retentionDays: 7 });
    const second = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    const blocked = [...second.options].find((o) => o.value === '31');
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.title).toContain('stations.sim.periodBeyondRetention');
  });

  it('shows why longer periods are not offered as visible text', async () => {
    renderTab({ historyDays: 10, retentionDays: 90 });
    expect(
      await screen.findByText(
        'stations.sim.periodBlockedHistory {"provider":"Hologram","days":10}',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/stations\.sim\.periodBlockedRetention/)).toBeNull();
    cleanup();
    renderTab({ historyDays: 90, retentionDays: 7 });
    expect(await screen.findByText('stations.sim.periodBlockedRetention {"days":7}')).toBeTruthy();
    cleanup();
    renderTab();
    await screen.findByLabelText('stations.sim.period');
    expect(screen.queryByText(/stations\.sim\.periodBlocked/)).toBeNull();
  });

  it('re-clamps the chosen period when a reload shortens the retention', async () => {
    renderTab();
    const select = await screen.findByLabelText<HTMLSelectElement>('stations.sim.period');
    fireEvent.change(select, { target: { value: '31' } });
    expect(select.value).toBe('31');
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/v1/stations/st1/sim') return Promise.resolve({ ...MATCHED, retentionDays: 14 });
      if (url.startsWith('/v1/stations/st1/sim/timeline')) return Promise.resolve(timeline);
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    fireEvent.click(screen.getByRole('button', { name: /stations\.sim\.refresh$/ }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('stations.sim.period').value).toBe('7');
    });
  });

  it('uses the coverage time zone of the reply for the range dialog days', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/v1/stations/st1/sim') {
        return Promise.resolve({ ...MATCHED, coverageTimeZone: 'Pacific/Kiritimati' });
      }
      if (url.startsWith('/v1/stations/st1/sim/timeline')) return Promise.resolve(timeline);
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StationConnectivityTab
            stationId="st1"
            iccid="8901"
            timezone="Etc/GMT+12"
            stationSignalEnabled={false}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.customRange' }));
    const dialog = await screen.findByRole('dialog');
    const to = within(dialog).getByLabelText<HTMLInputElement>('common.endDate');
    expect(to.value).toBe(zonedDate(new Date(), 'Pacific/Kiritimati'));
  });

  it('Refresh sends the chosen days and shows one result line per part', async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText('stations.sim.period'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /stations\.sim\.refresh$/ }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/st1/sim/refresh', { days: 3 });
    });
    const lines = await screen.findByTestId('sim-refresh-result');
    expect(lines.textContent).toContain(
      'stations.sim.result.providerOk {"sessions":"stations.sim.result.sessionCount {\\"count\\":12,\\"formatted\\":\\"12\\"}","alerts":"stations.sim.result.alertCount {\\"count\\":1,\\"formatted\\":\\"1\\"}"}',
    );
    expect(lines.textContent).toContain('stations.sim.result.stationSkipped.signalOff');
  });

  it('shows the translated error of a refused Refresh', async () => {
    apiMock.post.mockRejectedValue(new ApiError(400, { error: 'x', code: 'SIM_FEATURE_DISABLED' }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /stations\.sim\.refresh$/ }));
    expect(await screen.findByText('tr:errors.SIM_FEATURE_DISABLED')).toBeTruthy();
  });

  it('shows the wait of a rate limited Refresh', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(429, { error: 'x', code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 30 }),
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /stations\.sim\.refresh$/ }));
    expect(await screen.findByText('stations.sim.rateLimitedRetry {"seconds":30}')).toBeTruthy();
  });

  it('Custom Range opens the date dialog and Fetch sends the range', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.customRange' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('common.startDate'), {
      target: { value: dayOffset(3) },
    });
    fireEvent.change(within(dialog).getByLabelText('common.endDate'), {
      target: { value: dayOffset(2) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.fetch' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    const body = apiMock.post.mock.calls[0]?.[1] as { from: string; to: string };
    expect(body.from).toBe(`${dayOffset(3)}T00:00:00.000Z`);
    expect(body.to).toBe(`${dayOffset(1)}T00:00:00.000Z`);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('limits the dialog dates to the window and today', async () => {
    renderTab({ historyDays: 90, retentionDays: 30 });
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.customRange' }));
    const dialog = await screen.findByRole('dialog');
    for (const name of ['common.startDate', 'common.endDate']) {
      const input = within(dialog).getByLabelText<HTMLInputElement>(name);
      expect(input.min).toBe(dayOffset(30));
      expect(input.max).toBe(dayOffset(0));
      expect(input.getAttribute('aria-label')).toBeNull();
    }
  });

  it('refuses a range longer than 31 days in the dialog', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.customRange' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('common.startDate'), {
      target: { value: dayOffset(40) },
    });
    fireEvent.change(within(dialog).getByLabelText('common.endDate'), {
      target: { value: dayOffset(1) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.fetch' }));
    expect(await within(dialog).findByText('stations.sim.rangeTooLong {"days":31}')).toBeTruthy();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('says Not Fetched Yet before the first Refresh', async () => {
    renderTab({
      provider: null,
      reason: 'not_looked_up',
      capabilities: null,
      status: null,
      statusFetchedAt: null,
      match: null,
      lastFetchedAt: null,
    });
    const empty = await screen.findByTestId('sim-empty-not_looked_up');
    expect(within(empty).getByText('stations.sim.notFetchedYet')).toBeTruthy();
  });

  it('links a station without an ICCID to the Details tab', async () => {
    renderTab({
      provider: null,
      reason: 'no_iccid',
      capabilities: null,
      status: null,
      match: null,
    });
    const link = await screen.findByRole('link', { name: 'stations.sim.goToDetails' });
    expect(link.getAttribute('href')).toBe('/?tab=info');
  });

  it('links to the SIM provider settings only for users who can read them', async () => {
    const off = {
      provider: null,
      reason: 'no_provider_configured' as const,
      capabilities: null,
      status: null,
      match: null,
    };
    renderTab(off);
    const link = await screen.findByRole('link', { name: 'stations.sim.goToSettings' });
    expect(link.getAttribute('href')).toBe('/settings?tab=integrations&sub=simProviders');
    cleanup();
    perms.delete('settings.integrations:read');
    renderTab(off);
    expect(await screen.findByText('stations.sim.emptyNoProvider')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'stations.sim.goToSettings' })).toBeNull();
    cleanup();
    perms.add('settings.integrations:read');
    access.allSites = false;
    renderTab(off);
    expect(await screen.findByText('stations.sim.emptyNoProvider')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'stations.sim.goToSettings' })).toBeNull();
  });

  it('looks a missing SIM up again with a Refresh that skips the miss cache', async () => {
    renderTab({
      provider: null,
      reason: 'not_found',
      capabilities: null,
      status: null,
      match: null,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.lookUpAgain' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/st1/sim/refresh', {
        days: 7,
        retryLookup: true,
      });
    });
  });

  it('explains a SIM matched to another station', async () => {
    renderTab({
      provider: null,
      reason: 'sim_matched_elsewhere',
      capabilities: null,
      status: null,
      match: null,
    });
    expect(await screen.findByText('stations.sim.emptyMatchedElsewhere')).toBeTruthy();
  });

  it('shows the stored status with its time and the provider state beside the badge', async () => {
    renderTab();
    expect(await screen.findByText('stations.sim.state.active')).toBeTruthy();
    expect(
      screen.getByText('stations.sim.providerState {"provider":"Hologram","state":"LIVE"}'),
    ).toBeTruthy();
    expect(screen.getByText(/stations\.sim\.fetchedAt/)).toBeTruthy();
    expect(screen.getByText('T-Mobile (LTE)')).toBeTruthy();
    expect(screen.getByText(/stations\.sim\.notReported .*stations\.sim\.cellId/)).toBeTruthy();
    expect(screen.queryByTestId('sim-from-station')).toBeNull();
  });

  it('warns when usage passes 80 percent of a reported limit', async () => {
    renderTab({
      status: {
        ...(MATCHED.status as NonNullable<StationSimStatus['status']>),
        usage: { bytes: 900, periodEnd: null, limitBytes: 1000 },
      },
    });
    expect(await screen.findByText(/stations\.sim\.usageWarning/)).toBeTruthy();
    cleanup();
    renderTab();
    await screen.findByText('stations.sim.fromProviderTitle');
    expect(screen.queryByText(/stations\.sim\.usageWarning/)).toBeNull();
  });

  it('confirms an unconfirmed SIM through a dialog naming the ICCID and provider', async () => {
    apiMock.post.mockResolvedValue({ confirmed: true, confirmedAt: '2026-10-22T00:00:00Z' });
    renderTab({ match: UNCONFIRMED }, '89012345678901234567');
    expect(await screen.findByText(/^stations\.sim\.unconfirmedNotice/)).toBeTruthy();
    const reset = screen.getByRole('button', { name: 'stations.sim.resetNetwork' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'stations.sim.confirmSim' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('"iccid":"89012345678901234567"');
    expect(dialog.textContent).toContain('"provider":"Hologram"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.confirmSim' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/st1/sim/match/confirm', {
        matchedAt: '2026-10-21T09:30:00.000Z',
      });
    });
  });

  it('reloads the SIM status when the match changed after the dialog opened', async () => {
    apiMock.post.mockRejectedValue(new ApiError(409, { error: 'x', code: 'SIM_MATCH_CHANGED' }));
    renderTab({ match: UNCONFIRMED }, '89012345678901234567');
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.confirmSim' }));
    const dialog = await screen.findByRole('dialog');
    const reads = apiMock.get.mock.calls.filter(([url]) => url === '/v1/stations/st1/sim').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.confirmSim' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', title: 'tr:errors.SIM_MATCH_CHANGED' }),
      );
    });
    await waitFor(() => {
      expect(
        apiMock.get.mock.calls.filter(([url]) => url === '/v1/stations/st1/sim').length,
      ).toBeGreaterThan(reads);
    });
    // The dialog stays open on the reloaded match, so the person sees what they confirm.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('explains why Reset Network is disabled before the SIM is confirmed', async () => {
    renderTab({ match: UNCONFIRMED });
    const reset = await screen.findByRole('button', { name: 'stations.sim.resetNetwork' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    const trigger = screen.getByTestId('sim-reset-disabled');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.contains(reset)).toBe(true);
    expect(trigger.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.focus(trigger);
    expect((await screen.findByRole('tooltip')).textContent).toBe('stations.sim.resetNeedsConfirm');
  });

  it('clears the match after a confirmation and reloads the SIM status', async () => {
    apiMock.delete.mockResolvedValue(undefined);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.clearMatch' }));
    const before = getCalls().length;
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('stations.sim.clearMatchDescription')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.clearMatch' }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/stations/st1/sim/match');
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'stations.sim.clearMatchSuccess',
      });
    });
    await waitFor(() => {
      expect(getCalls().slice(before)).toContain('/v1/stations/st1/sim');
    });
  });

  it('hides Clear Match without stations:write', async () => {
    perms.delete('stations:write');
    renderTab();
    await screen.findByText('stations.sim.fromProviderTitle');
    expect(screen.queryByRole('button', { name: 'stations.sim.clearMatch' })).toBeNull();
  });

  it('shows the wait of a refused network reset', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(429, { error: 'x', code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 45 }),
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.resetNetwork' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.resetNetwork' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'stations.sim.rateLimitedRetry {"seconds":45}',
      });
    });
  });

  it('says an unconfirmed match fetches nothing until Confirm SIM, and lists no alerts', async () => {
    renderTab(UNCONFIRMED_SIM);
    expect(
      await screen.findByText('stations.sim.unconfirmedNotice {"provider":"Hologram"}'),
    ).toBeTruthy();
    expect(screen.queryByTestId('sim-recent-alerts')).toBeNull();
  });

  it('names where the ICCID came from in the Confirm SIM dialog', async () => {
    renderTab(UNCONFIRMED_SIM);
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.confirmSim' }));
    expect(
      within(await screen.findByRole('dialog')).getByText('stations.sim.confirmSourceStation'),
    ).toBeTruthy();
    cleanup();
    renderTab({
      ...UNCONFIRMED_SIM,
      match: {
        ...UNCONFIRMED,
        iccidSource: 'entered',
        enteredBy: { id: 'usr_2', name: 'Sam Site' },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.confirmSim' }));
    expect(
      within(await screen.findByRole('dialog')).getByText(
        'stations.sim.confirmSourceEntered {"name":"Sam Site"}',
      ),
    ).toBeTruthy();
    cleanup();
    renderTab({
      ...UNCONFIRMED_SIM,
      match: { ...UNCONFIRMED, iccidSource: 'entered', enteredBy: { id: 'usr_3', name: null } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.confirmSim' }));
    expect(
      within(await screen.findByRole('dialog')).getByText(
        'stations.sim.confirmSourceEnteredUnknown',
      ),
    ).toBeTruthy();
  });

  it('shows why Confirm SIM was refused when another station holds the SIM', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(409, { error: 'x', code: 'SIM_CONFIRMED_ELSEWHERE' }),
    );
    renderTab(UNCONFIRMED_SIM);
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.confirmSim' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.confirmSim' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'tr:errors.SIM_CONFIRMED_ELSEWHERE',
      });
    });
  });

  it('shows the translated error of a reset whose cooldown could not be checked', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(503, { error: 'x', code: 'SIM_RESET_UNAVAILABLE' }),
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.resetNetwork' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.resetNetwork' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'tr:errors.SIM_RESET_UNAVAILABLE',
      });
    });
  });

  it('hides Confirm SIM without access to every site or stations:write', async () => {
    access.allSites = false;
    renderTab({ match: UNCONFIRMED });
    await screen.findByText(/^stations\.sim\.unconfirmedNotice/);
    expect(screen.queryByRole('button', { name: 'stations.sim.confirmSim' })).toBeNull();
    cleanup();
    access.allSites = true;
    perms.delete('stations:write');
    renderTab({ match: UNCONFIRMED });
    await screen.findByText(/^stations\.sim\.unconfirmedNotice/);
    expect(screen.queryByRole('button', { name: 'stations.sim.confirmSim' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'stations.sim.resetNetwork' })).toBeNull();
  });

  it('resets the network of a confirmed SIM after the confirmation', async () => {
    apiMock.post.mockResolvedValue({ status: 'accepted' });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'stations.sim.resetNetwork' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('stations.sim.resetDescription')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'stations.sim.resetNetwork' }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/st1/sim/network-reset', {});
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'stations.sim.resetSuccess',
      });
    });
  });

  it('hides Reset Network when the provider does not support it', async () => {
    renderTab({
      capabilities: {
        ...(MATCHED.capabilities as NonNullable<StationSimStatus['capabilities']>),
        networkReset: false,
      },
    });
    await screen.findByText('stations.sim.fromProviderTitle');
    expect(screen.queryByRole('button', { name: 'stations.sim.resetNetwork' })).toBeNull();
  });

  it('labels each coverage day with text and an accessible name', async () => {
    timeline = {
      ...EMPTY_TIMELINE,
      days: [
        { date: dayOffset(6), label: 'has_data' },
        { date: dayOffset(5), label: 'no_sessions' },
        { date: dayOffset(4), label: 'partial' },
        { date: dayOffset(3), label: 'not_fetched' },
        { date: dayOffset(2), label: 'unavailable' },
        { date: dayOffset(0), label: 'pending' },
      ],
    };
    renderTab();
    const strip = await screen.findByTestId('sim-coverage-scroll');
    for (const key of [
      'hasData',
      'noSessions',
      'partial',
      'pending',
      'notFetched',
      'unavailable',
    ]) {
      expect(within(strip).getAllByText(`stations.simCoverage.${key}`).length).toBe(1);
    }
    expect(within(strip).getAllByLabelText(/stations\.simCoverage\.dayLabel/).length).toBe(6);
    expect(screen.getByText('stations.simCoverage.legend')).toBeTruthy();
    // The tone marks the border and icon; the date and label stay in the body text color.
    const notFetched = within(screen.getByTestId(`sim-coverage-day-${dayOffset(3)}`)).getByTestId(
      'sim-coverage-cell',
    );
    expect(notFetched.className).toContain('border-dashed');
    expect(notFetched.className).not.toContain('destructive');
    expect(notFetched.className).toContain('text-foreground');
    expect(notFetched.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
    const hasData = within(screen.getByTestId(`sim-coverage-day-${dayOffset(6)}`)).getByTestId(
      'sim-coverage-cell',
    );
    expect(hasData.className).toContain('border-success');
    expect(hasData.className).toContain('text-foreground');
    expect(hasData.querySelector('svg')?.getAttribute('class')).toContain('text-success');
    // A clickable day and a static day have the same box.
    const box = (el: HTMLElement): string[] =>
      el.className
        .split(/\s+/)
        .filter((c) => c !== '' && !/^(bg|border)-/.test(c))
        .sort();
    expect(box(notFetched)).toEqual(box(hasData));
    // Phones: the strip scrolls in its own container instead of widening the page.
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).toContain('max-w-full');
    expect(strip.firstElementChild?.className).toContain('w-max');
  });

  it('opens the date dialog with a Not Fetched day filled in', async () => {
    timeline = { ...EMPTY_TIMELINE, days: [{ date: dayOffset(3), label: 'not_fetched' }] };
    renderTab();
    const day = await screen.findByTestId(`sim-coverage-day-${dayOffset(3)}`);
    fireEvent.click(within(day).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('common.startDate').value).toBe(
      dayOffset(3),
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('common.endDate').value).toBe(
      dayOffset(3),
    );
  });

  it('shows one Not Fetched row per gap with a Fetch button for its range', async () => {
    timeline = {
      ...EMPTY_TIMELINE,
      items: [
        {
          at: new Date().toISOString(),
          source: 'ocpp',
          kind: 'disconnected',
          details: { reason: 'server_shutdown' },
        },
      ],
      days: [
        { date: dayOffset(4), label: 'not_fetched' },
        { date: dayOffset(3), label: 'not_fetched' },
        { date: dayOffset(2), label: 'has_data' },
      ],
    };
    renderTab();
    const gap = await screen.findByTestId('sim-timeline-gap');
    expect(gap.textContent).toContain('stations.simCoverage.notFetchedRange');
    expect(screen.getByText(/stations\.sim\.disconnectReason\.serverShutdown/)).toBeTruthy();
    fireEvent.click(within(gap).getByRole('button', { name: 'stations.sim.fetch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('common.startDate').value).toBe(
      dayOffset(4),
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('common.endDate').value).toBe(
      dayOffset(3),
    );
  });

  it('labels each disconnect with its likely cause and what to check next', async () => {
    timeline = {
      ...EMPTY_TIMELINE,
      items: [
        { at: '2026-10-21T10:00:00Z', source: 'ocpp', kind: 'connected', details: {} },
        {
          at: '2026-10-21T09:00:00Z',
          source: 'ocpp',
          kind: 'disconnected',
          details: { offlineCause: 'network' },
        },
        {
          at: '2026-10-21T08:00:00Z',
          source: 'ocpp',
          kind: 'disconnected',
          details: { offlineCause: 'sim_account' },
        },
      ],
    };
    renderTab();
    const list = await screen.findByTestId('sim-timeline');
    expect(within(list).getByText('stations.sim.offlineCause.network')).toBeTruthy();
    expect(within(list).getByText('stations.sim.offlineCause.simAccount')).toBeTruthy();
    const hints = within(list)
      .getAllByTestId('offline-cause-hint')
      .map((h) => h.textContent);
    expect(hints).toEqual([
      'stations.sim.offlineCauseHint.network',
      'stations.sim.offlineCauseHint.simAccount',
    ]);
  });

  it('labels the timeline sources and loads more with the cursor', async () => {
    timeline = {
      ...EMPTY_TIMELINE,
      items: [
        {
          at: '2026-10-21T10:00:00Z',
          source: 'sim',
          kind: 'session',
          details: { endedAt: '2026-10-21T11:00:00Z', bytes: 2048, networkName: 'AT&T' },
        },
        { at: '2026-10-21T09:00:00Z', source: 'sim', kind: 'data_limit', details: {} },
      ],
      nextCursor: 'c1',
    };
    renderTab();
    const list = await screen.findByTestId('sim-timeline');
    expect(within(list).getAllByText('stations.sim.sourceSim')).toHaveLength(2);
    expect(within(list).getByText('stations.sim.kind.session')).toBeTruthy();
    expect(within(list).getByText('stations.sim.kind.dataLimit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'stations.sim.loadMore' }));
    await waitFor(() => {
      expect(getCalls().some((u) => u.includes('cursor=c1'))).toBe(true);
    });
  });

  it('lists the newest stored SIM alerts and says they arrive with a Refresh', async () => {
    renderTab({
      recentAlerts: [
        { kind: 'data_limit', receivedAt: '2026-10-21T09:00:00Z' },
        { kind: 'device_changed', receivedAt: '2026-10-20T09:00:00Z' },
      ],
    });
    const section = await screen.findByTestId('sim-recent-alerts');
    expect(within(section).getByText('stations.sim.kind.dataLimit')).toBeTruthy();
    expect(within(section).getByText('stations.sim.kind.deviceChanged')).toBeTruthy();
    expect(within(section).getByText('stations.sim.alertsRefreshNote')).toBeTruthy();
  });

  it('says no SIM alerts are stored, and hides the list when the provider has none', async () => {
    renderTab({ recentAlerts: [] });
    const section = await screen.findByTestId('sim-recent-alerts');
    expect(within(section).getByText('stations.sim.noRecentAlerts')).toBeTruthy();
    cleanup();
    const capabilities = MATCHED.capabilities;
    if (capabilities == null) throw new Error('MATCHED has capabilities');
    renderTab({ capabilities: { ...capabilities, alerts: false } });
    await screen.findByText(/stations\.sim\.notReported/);
    expect(screen.queryByTestId('sim-recent-alerts')).toBeNull();
  });

  const STATION: NonNullable<StationSimStatus['station']> = {
    protocol: 'ocpp2x',
    deviceModel: 'ok',
    readAt: '2026-10-21T10:00:00Z',
    values: { 'DataLink[Modem1].SignalStrength': '-91', 'DataLink[Modem1].Active': 'true' },
    dataLinks: [
      {
        instance: 'Modem1',
        values: { SignalStrength: '-91', Active: 'true', NetworkAddress: '10.0.0.7' },
        signalUnit: 'dBm',
        signal: { value: -91, unit: 'dBm', inferred: false, dbm: -91, grade: 'poor' },
      },
    ],
    activeNetworkProfile: '1',
    thresholds: { goodDbm: -65, fairDbm: -85 },
  };

  it('renders the station values only when the reply carries them', async () => {
    renderTab();
    await screen.findByText(/stations\.sim\.providerState/);
    expect(screen.queryByTestId('sim-from-station')).toBeNull();
    cleanup();
    renderTab({ station: STATION });
    const section = await screen.findByTestId('sim-from-station');
    expect(within(section).getByText('stations.sim.station.signalStrength')).toBeTruthy();
    expect(within(section).getByText('stations.sim.station.active')).toBeTruthy();
    expect(within(section).getByText('stations.sim.station.yes')).toBeTruthy();
    expect(within(section).getByText('10.0.0.7')).toBeTruthy();
    expect(within(section).getByText('stations.sim.station.activeNetworkProfile')).toBeTruthy();
  });

  it('shows the signal grade with the value and its source', async () => {
    renderTab({ station: STATION });
    const signal = await screen.findByTestId('sim-signal');
    expect(signal.textContent).toContain('stations.sim.station.dbmValue');
    expect(within(signal).getByText('stations.sim.station.grade.poor')).toBeTruthy();
    expect(screen.getByText('stations.sim.station.source')).toBeTruthy();
    const info = screen.getByLabelText('stations.sim.station.gradeInfo');
    expect(info.tabIndex).toBe(0);
    fireEvent.focus(info);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'stations.sim.station.gradeCaveat',
    );
  });

  it('offers Read Device Model before the station reported a modem, only with stations:write', async () => {
    apiMock.post.mockResolvedValue({ success: true });
    renderTab({ station: { ...STATION, deviceModel: 'unread', dataLinks: [], readAt: null } });
    const section = await screen.findByTestId('sim-from-station');
    fireEvent.click(
      within(section).getByRole('button', { name: 'stations.sim.station.readDeviceModel' }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/stations/st1/configurations/refresh', {});
    });
    cleanup();
    perms.delete('stations:write');
    renderTab({ station: { ...STATION, deviceModel: 'unread', dataLinks: [], readAt: null } });
    const readOnly = await screen.findByTestId('sim-from-station');
    expect(
      within(readOnly).queryByRole('button', { name: 'stations.sim.station.readDeviceModel' }),
    ).toBeNull();
  });

  it('hides the station section when the station reports no modem', async () => {
    renderTab({ station: { ...STATION, deviceModel: 'no_datalink', dataLinks: [] } });
    await screen.findByText(/stations\.sim\.providerState/);
    expect(screen.queryByTestId('sim-from-station')).toBeNull();
  });

  it('lists the OCPP 1.6 keys as the station reported them', async () => {
    renderTab({
      station: {
        ...STATION,
        protocol: 'ocpp1.6',
        deviceModel: null,
        dataLinks: [],
        activeNetworkProfile: null,
        values: { RSSI: '-83', MCC: null },
      },
    });
    const section = await screen.findByTestId('sim-from-station');
    expect(within(section).getByText('RSSI')).toBeTruthy();
    expect(within(section).getByText('-83')).toBeTruthy();
    expect(within(section).getByText('stations.sim.station.ocpp16Keys')).toBeTruthy();
  });

  it('labels the low signal events of the timeline', async () => {
    timeline = {
      ...EMPTY_TIMELINE,
      items: [
        {
          at: '2026-10-21T10:00:00Z',
          source: 'ocpp',
          kind: 'signal_restored',
          details: { instance: 'Modem1', actualValue: '-88' },
        },
        {
          at: '2026-10-21T09:00:00Z',
          source: 'ocpp',
          kind: 'signal_low',
          details: { instance: 'Modem1', actualValue: '-104' },
        },
      ],
    };
    renderTab();
    const list = await screen.findByTestId('sim-timeline');
    expect(within(list).getByText('stations.sim.kind.signalLow')).toBeTruthy();
    expect(within(list).getByText('stations.sim.kind.signalRestored')).toBeTruthy();
    expect(within(list).getByText(/stations\.sim\.signalReading \{"value":"-104"\}/)).toBeTruthy();
  });
});
