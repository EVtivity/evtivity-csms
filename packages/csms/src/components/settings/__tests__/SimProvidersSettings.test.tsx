// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms, access } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  perms: new Set<string>(),
  access: { allSites: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Error codes translate (getErrorMessage falls back to the API text otherwise).
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
  useHasCompanyWidePermission: (p: string) => access.allSites && perms.has(p),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '@/lib/api';
import { SimProvidersSettings } from '../SimProvidersSettings';

const SETTINGS = {
  hologram: { enabled: false, orgId: '', apiKey: null, apiKeyConfigured: false },
  '1nce': { enabled: false, clientId: '', clientSecret: null, clientSecretConfigured: false },
  retentionDays: 90,
  fetchDays: 7,
  stationSignalEnabled: false,
  signalAlertBelowDbm: null,
  ocpp16SignalKeys: [],
  signalGoodDbm: -65,
  signalFairDbm: -85,
};

let client: QueryClient;

/** The Test Connection button of one provider card (each card has its own). */
function testButton(form = 'sim-hologram-form'): HTMLButtonElement {
  return within(screen.getByTestId(form)).getByRole<HTMLButtonElement>('button', {
    name: 'settings.sim.testConnection',
  });
}

async function findTestButton(form = 'sim-hologram-form'): Promise<HTMLButtonElement> {
  return within(await screen.findByTestId(form)).findByRole<HTMLButtonElement>('button', {
    name: 'settings.sim.testConnection',
  });
}

function renderSettings(data: Record<string, unknown> = SETTINGS): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/settings/sim-providers') return Promise.resolve(data);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SimProvidersSettings />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  perms.clear();
  perms.add('settings.integrations:read');
  perms.add('settings.integrations:write');
  access.allSites = true;
  apiMock.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SimProvidersSettings', () => {
  it('reads the settings only with access to every site', () => {
    access.allSites = false;
    renderSettings();
    expect(screen.getByText('settings.sim.allSitesOnly')).toBeTruthy();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('shows the Hologram, Session History and station signal cards', async () => {
    renderSettings();
    expect(await screen.findByText('settings.sim.hologramTitle')).toBeTruthy();
    expect(screen.getByText('settings.sim.sessionHistoryTitle')).toBeTruthy();
    expect(screen.getByText('settings.sim.stationSignalTitle')).toBeTruthy();
    expect(screen.getByText('settings.sim.hologramApiKeyHint')).toBeTruthy();
    expect(screen.getByText('settings.sim.fetchDaysHint')).toBeTruthy();
    // The retention moved to Settings > Data Retention: the card links there.
    expect(screen.queryByLabelText('settings.sim.retentionDays')).toBeNull();
    expect(screen.getByTestId('data-retention-link').querySelector('a')?.getAttribute('href')).toBe(
      '/settings?tab=dataRetention',
    );
    expect(screen.getByText('settings.sim.sessionHistoryNote')).toBeTruthy();
    expect(screen.getByText('settings.sim.stationSignalHint')).toBeTruthy();
  });

  it('saves the Hologram account with the organization id and API key', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('switch', { name: 'settings.sim.hologramEnabled' }));
    fireEvent.change(screen.getByLabelText('settings.sim.hologramOrgId'), {
      target: { value: '12345' },
    });
    fireEvent.change(screen.getByLabelText('settings.sim.hologramApiKey'), {
      target: { value: ' key-1 ' },
    });
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
        hologram: { enabled: true, orgId: '12345', apiKey: 'key-1' },
      });
    });
  });

  it('refuses an organization id that is not 1 to 15 digits', async () => {
    renderSettings();
    fireEvent.change(await screen.findByLabelText('settings.sim.hologramOrgId'), {
      target: { value: '12a' },
    });
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    expect(await screen.findByText('settings.sim.hologramOrgIdInvalid')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('keeps a stored API key hidden from a user without settings.system:read', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: null, apiKeyConfigured: true },
    });
    expect(await screen.findByText('settings.secretStoredHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'settings.sim.hologramEnabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.toggleOff.confirm' }));
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
        hologram: { enabled: false, orgId: '7' },
      });
    });
  });

  it('clears a typed API key and a removal after a save, when the reload hides the key', async () => {
    const stored = {
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: null, apiKeyConfigured: true },
    };
    renderSettings(stored);
    const input = await screen.findByLabelText<HTMLInputElement>('settings.sim.hologramApiKey');
    fireEvent.change(input, { target: { value: 'new-key' } });
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
        hologram: { enabled: true, orgId: '7', apiKey: 'new-key' },
      });
    });
    expect(await screen.findByText('settings.sim.saved')).toBeTruthy();
    expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('settings.sim.hologramApiKey').value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'settings.secretRemove' }));
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenLastCalledWith('/v1/settings/sim-providers', {
        hologram: { enabled: true, orgId: '7', apiKey: '' },
      });
    });
    expect(await screen.findByText('settings.sim.saved')).toBeTruthy();
    expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
    expect(screen.queryByText('settings.secretRemovePending')).toBeNull();
  });

  describe('first API key save', () => {
    /**
     * A server that stores the saved key and returns it only to settings.system:read
     * holders. The save answers only when `answerSave` runs, so a test can let the
     * settings reload land before the save's own callback, as it can in a browser.
     */
    let answerSave: () => void = () => undefined;

    function renderStatefulServer(): void {
      const stored = { enabled: false, orgId: '', apiKey: null as string | null };
      apiMock.put.mockImplementation(
        (
          _url: string,
          body: { hologram: { enabled: boolean; orgId: string; apiKey?: string } },
        ) => {
          stored.enabled = body.hologram.enabled;
          stored.orgId = body.hologram.orgId;
          if (body.hologram.apiKey !== undefined) stored.apiKey = body.hologram.apiKey || null;
          return new Promise((resolve) => {
            answerSave = () => {
              resolve({ success: true });
            };
          });
        },
      );
      apiMock.get.mockImplementation(() =>
        Promise.resolve({
          ...SETTINGS,
          '1nce': SETTINGS['1nce'],
          hologram: {
            enabled: stored.enabled,
            orgId: stored.orgId,
            apiKey: perms.has('settings.system:read') ? stored.apiKey : null,
            apiKeyConfigured: stored.apiKey != null,
          },
        }),
      );
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <SimProvidersSettings />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    }

    /** Turns Hologram on with an organization and its first API key, as the E2E spec does. */
    async function saveFirstKey(reloadFirst: boolean): Promise<void> {
      fireEvent.click(await screen.findByRole('switch', { name: 'settings.sim.hologramEnabled' }));
      fireEvent.change(screen.getByLabelText('settings.sim.hologramOrgId'), {
        target: { value: '7' },
      });
      fireEvent.change(screen.getByLabelText('settings.sim.hologramApiKey'), {
        target: { value: ' key-1 ' },
      });
      fireEvent.submit(screen.getByTestId('sim-hologram-form'));
      await waitFor(() => {
        expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
          hologram: { enabled: true, orgId: '7', apiKey: 'key-1' },
        });
      });
      if (reloadFirst) await client.refetchQueries({ queryKey: ['sim-provider-settings'] });
      answerSave();
      expect(await screen.findByText('settings.sim.saved')).toBeTruthy();
    }

    for (const reloadFirst of [false, true]) {
      const when = reloadFirst ? 'when the reload lands first' : 'when the save answers first';

      it(`keeps the key and enables Test Connection for a user who reads secrets, ${when}`, async () => {
        perms.add('settings.system:read');
        renderStatefulServer();
        await saveFirstKey(reloadFirst);
        await waitFor(() => {
          expect(screen.getByLabelText<HTMLInputElement>('settings.sim.hologramApiKey').value).toBe(
            'key-1',
          );
        });
        expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
        expect(testButton().disabled).toBe(false);
      });

      it(`empties the field and enables Test Connection without settings.system:read, ${when}`, async () => {
        renderStatefulServer();
        await saveFirstKey(reloadFirst);
        expect(await screen.findByText('settings.secretStoredHint')).toBeTruthy();
        expect(screen.getByLabelText<HTMLInputElement>('settings.sim.hologramApiKey').value).toBe(
          '',
        );
        expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
        expect(testButton().disabled).toBe(false);
      });
    }
  });

  it('tests the stored connection and names other organizations with SIMs', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    apiMock.post.mockResolvedValue({
      provider: 'hologram',
      deviceCount: 0,
      otherOrganizations: [
        { id: '8', name: 'Fleet Org', deviceCount: 1234 },
        { id: '9', name: 'Empty Org', deviceCount: 0 },
      ],
    });
    fireEvent.click(await findTestButton());
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/settings/sim-providers/hologram/test', {});
    });
    expect(await screen.findByText('settings.sim.testSuccess {"count":0}')).toBeTruthy();
    const warning = screen.getByText('settings.sim.testOtherOrganizations').closest('div');
    expect(warning?.textContent).toContain('Fleet Org (8): 1,234');
    expect(warning?.textContent).not.toContain('Empty Org');
  });

  it('shows no organization warning when the stored organization has SIMs', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    apiMock.post.mockResolvedValue({
      provider: 'hologram',
      deviceCount: 3,
      otherOrganizations: [{ id: '8', name: 'Fleet Org', deviceCount: 4 }],
    });
    fireEvent.click(await findTestButton());
    expect(await screen.findByText('settings.sim.testSuccess {"count":3}')).toBeTruthy();
    expect(screen.queryByText('settings.sim.testOtherOrganizations')).toBeNull();
  });

  it('shows the translated error of a failed connection test', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    apiMock.post.mockRejectedValue(
      new ApiError(502, { error: 'x', code: 'SIM_PROVIDER_ERROR', kind: 'auth' }),
    );
    fireEvent.click(await findTestButton());
    expect(await screen.findByText('tr:errors.SIM_PROVIDER_ERROR')).toBeTruthy();
  });

  it('shows the wait of a rate limited connection test', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    apiMock.post.mockRejectedValue(
      new ApiError(429, { error: 'x', code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 20 }),
    );
    fireEvent.click(await findTestButton());
    expect(await screen.findByText('stations.sim.rateLimitedRetry {"seconds":20}')).toBeTruthy();
  });

  it('reloads the feature flags after a save, so the station pages follow the switches', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: false, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('switch', { name: 'settings.sim.hologramEnabled' }));
    fireEvent.submit(screen.getByTestId('sim-hologram-form'));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'features'] });
    });
  });

  it('tests only the saved values', async () => {
    renderSettings({
      ...SETTINGS,
      hologram: { enabled: true, orgId: '7', apiKey: 'k', apiKeyConfigured: true },
    });
    fireEvent.change(await screen.findByLabelText('settings.sim.hologramOrgId'), {
      target: { value: '8' },
    });
    expect(testButton().disabled).toBe(true);
    expect(screen.getByText('settings.sim.testSaveFirst')).toBeTruthy();
  });

  describe('1NCE card', () => {
    it('saves only the 1NCE block with the trimmed client id and secret', async () => {
      renderSettings();
      expect(await screen.findByText('settings.sim.oneNceTitle')).toBeTruthy();
      expect(screen.getByText('settings.sim.oneNceClientIdHint')).toBeTruthy();
      fireEvent.click(screen.getByRole('switch', { name: 'settings.sim.oneNceEnabled' }));
      fireEvent.change(screen.getByLabelText('settings.sim.oneNceClientId'), {
        target: { value: ' client-1 ' },
      });
      fireEvent.change(screen.getByLabelText('settings.sim.oneNceClientSecret'), {
        target: { value: ' secret-1 ' },
      });
      fireEvent.submit(screen.getByTestId('sim-1nce-form'));
      await waitFor(() => {
        expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
          '1nce': { enabled: true, clientId: 'client-1', clientSecret: 'secret-1' },
        });
      });
    });

    it('refuses a client id with a colon or a space, and requires one while on', async () => {
      renderSettings();
      fireEvent.change(await screen.findByLabelText('settings.sim.oneNceClientId'), {
        target: { value: 'user:pass' },
      });
      fireEvent.submit(screen.getByTestId('sim-1nce-form'));
      expect(await screen.findByText('settings.sim.oneNceClientIdInvalid')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('settings.sim.oneNceClientId'), {
        target: { value: '' },
      });
      fireEvent.click(screen.getByRole('switch', { name: 'settings.sim.oneNceEnabled' }));
      fireEvent.submit(screen.getByTestId('sim-1nce-form'));
      expect(await screen.findByText('validation.required')).toBeTruthy();
      expect(apiMock.put).not.toHaveBeenCalled();
    });

    it('keeps a stored secret hidden from a user without settings.system:read', async () => {
      renderSettings({
        ...SETTINGS,
        '1nce': {
          enabled: true,
          clientId: 'client-1',
          clientSecret: null,
          clientSecretConfigured: true,
        },
      });
      const form = await screen.findByTestId('sim-1nce-form');
      expect(within(form).getByText('settings.secretStoredHint')).toBeTruthy();
      expect(
        within(form).getByLabelText<HTMLInputElement>('settings.sim.oneNceClientSecret').value,
      ).toBe('');
      fireEvent.click(screen.getByRole('switch', { name: 'settings.sim.oneNceEnabled' }));
      fireEvent.click(screen.getByRole('button', { name: 'common.toggleOff.confirm' }));
      fireEvent.submit(form);
      await waitFor(() => {
        expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
          '1nce': { enabled: false, clientId: 'client-1' },
        });
      });
    });

    it('tests the saved 1NCE account only while it is on and unchanged', async () => {
      renderSettings({
        ...SETTINGS,
        '1nce': {
          enabled: true,
          clientId: 'client-1',
          clientSecret: 's',
          clientSecretConfigured: true,
        },
      });
      apiMock.post.mockResolvedValue({ provider: '1nce', deviceCount: 2, otherOrganizations: [] });
      fireEvent.click(await findTestButton('sim-1nce-form'));
      await waitFor(() => {
        expect(apiMock.post).toHaveBeenCalledWith('/v1/settings/sim-providers/1nce/test', {});
      });
      expect(await screen.findByText('settings.sim.oneNceTestSuccess {"count":2}')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('settings.sim.oneNceClientId'), {
        target: { value: 'client-2' },
      });
      expect(testButton('sim-1nce-form').disabled).toBe(true);
    });

    it('disables Test Connection while 1NCE is off', async () => {
      renderSettings();
      expect((await findTestButton('sim-1nce-form')).disabled).toBe(true);
      expect(screen.getByText('settings.sim.oneNceTestEnableFirst')).toBeTruthy();
    });
  });

  it('saves the Refresh period within its range', async () => {
    renderSettings();
    const fetchDays = await screen.findByLabelText('settings.sim.fetchDays');
    fireEvent.change(fetchDays, { target: { value: '40' } });
    fireEvent.submit(screen.getByTestId('sim-history-form'));
    expect(await screen.findByText('settings.sim.rangeError {"min":1,"max":31}')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();

    fireEvent.change(fetchDays, { target: { value: '14' } });
    fireEvent.submit(screen.getByTestId('sim-history-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', { fetchDays: 14 });
    });
  });

  it('saves the station signal settings, an empty alert turning it off', async () => {
    renderSettings({ ...SETTINGS, signalAlertBelowDbm: -100 });
    fireEvent.click(
      await screen.findByRole('switch', { name: 'settings.sim.stationSignalEnabled' }),
    );
    fireEvent.change(screen.getByLabelText('settings.sim.signalAlertBelowDbm'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('settings.sim.ocpp16SignalKeys'), {
      target: { value: 'RSSI\nCellID\n\nRSSI' },
    });
    fireEvent.submit(screen.getByTestId('sim-signal-form'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/sim-providers', {
        stationSignalEnabled: true,
        signalAlertBelowDbm: null,
        ocpp16SignalKeys: ['RSSI', 'CellID'],
        signalGoodDbm: -65,
        signalFairDbm: -85,
      });
    });
  });

  it('refuses a good threshold not above the fair one', async () => {
    renderSettings();
    fireEvent.change(await screen.findByLabelText('settings.sim.signalGoodDbm'), {
      target: { value: '-90' },
    });
    fireEvent.submit(screen.getByTestId('sim-signal-form'));
    expect(await screen.findByText('settings.sim.signalOrderError')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('is read-only without settings.integrations:write', async () => {
    perms.delete('settings.integrations:write');
    renderSettings();
    const orgId = await screen.findByLabelText('settings.sim.hologramOrgId');
    expect((orgId as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'settings.sim.testConnection' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /common.save/ })).toHaveLength(0);
  });
});
