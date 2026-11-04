// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

const { getMock, postMock, patchMock, putMock, deleteMock, toastMock, state } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
  state: { allSites: true, canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null
        ? key
        : `${key}:${Object.entries(opts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return {
    api: { get: getMock, post: postMock, patch: patchMock, put: putMock, delete: deleteMock },
    ApiError,
  };
});
vi.mock('@/lib/auth', () => ({
  useHasAllSiteAccess: () => state.allSites,
  useHasPermission: (p: string) => (p.endsWith(':write') ? state.canWrite : true),
  useHasCompanyWidePermission: () => state.allSites,
}));
vi.mock('@/lib/timezone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/timezone')>()),
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/EntityHistoryTab', () => ({
  EntityHistoryTab: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="history">{`${entityType}:${entityId}`}</div>
  ),
}));
// A stand-in proof field: one button gives a password proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (p: unknown) => void;
    showMissing?: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onChange({ kind: 'password', password: 'pw' });
        }}
      >
        give-proof
      </button>
      {showMissing === true && <span>proof-missing</span>}
    </div>
  ),
  proofRejection: () => ({ code: null }),
}));

import { BusDepotSystemsSettings } from '../BusDepotSystemsSettings';
import {
  IDENTIFIER_CSV_HEADERS,
  identifierCsvRows,
} from '@/components/depot-systems/DepotSystemDetail';
import {
  VDV463_REFUSAL_REASONS,
  isConnectedNow,
  isValidPresystemId,
} from '@/components/depot-systems/depot-system-types';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import es from '../../../i18n/locales/es.json';
import ko from '../../../i18n/locales/ko.json';
import zh from '../../../i18n/locales/zh.json';
import zhTW from '../../../i18n/locales/zh-TW.json';

const system = {
  id: 'dms_1',
  presystemId: 'BMS-NORTH',
  name: 'Depot North BMS',
  systemType: 'BMS',
  isEnabled: false,
  siteIds: ['sit_depot'],
  infoIntervalSeconds: 30,
  requestTimeoutSeconds: 30,
  maxRetries: 3,
  keepaliveTimeoutSeconds: 180,
  locked: false,
  lastConnectedAt: null,
  lastBootAt: null,
  lastMessageAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const identifiers = {
  depots: [
    {
      depotId: 'sit_depot',
      name: 'North Depot',
      stations: [{ chargingStationId: 'CS-1', chargingPointIds: ['CS-1/1', 'CS-1/2'] }],
    },
  ],
  buses: [{ vehicleId: 'VIN00000000000001', licensePlate: 'BUS-1', batteryCapacityKwh: null }],
  connection: { path: '/vdv463', subprotocol: 'v1.463.vdv.de' },
};

function mockReads(
  detail: Record<string, unknown> = {},
  identifiersReply: Record<string, unknown> = identifiers,
): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/depot-systems') {
      return Promise.resolve({
        data: [system],
        connection: { path: '/vdv463', subprotocol: 'v1.463.vdv.de' },
      });
    }
    if (url === '/v1/depot-systems/dms_1') {
      return Promise.resolve({
        ...system,
        refusedRequests: [
          {
            requestId: 'req-7',
            vehicleRef: 'VIN00000000000009',
            reason: 'vehicle_not_bus',
            refusedAt: '2026-11-02T08:00:00.000Z',
          },
        ],
        ...detail,
      });
    }
    if (url === '/v1/depot-systems/dms_1/identifiers') return Promise.resolve(identifiersReply);
    if (url.startsWith('/v1/sites')) {
      return Promise.resolve({
        data: [
          { id: 'sit_depot', name: 'North Depot', layoutSettings: { siteType: 'depot' } },
          { id: 'sit_south', name: 'South Depot', layoutSettings: { siteType: 'depot' } },
          { id: 'sit_lot', name: 'Main Lot', layoutSettings: null },
        ],
        total: 3,
      });
    }
    if (url === '/v1/users/me/mfa') {
      return Promise.resolve({ factorProofKinds: ['password'], mfaMethod: null });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function wrap(path = '/settings?tab=integrations&sub=depot-systems'): void {
  // The tab helpers read the address bar, so the test starts there.
  window.history.replaceState(null, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <BusDepotSystemsSettings settings={{ 'vdv463.enabled': true }} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.allSites = true;
  state.canWrite = true;
});

describe('BusDepotSystemsSettings', () => {
  it('lists the systems with the WebSocket address and subprotocol for the vendor', async () => {
    mockReads();
    wrap();
    const row = await screen.findByTestId('depot-system-row-dms_1');
    expect(within(row).getByText('Depot North BMS')).toBeTruthy();
    expect(within(row).getByText('BMS-NORTH')).toBeTruthy();
    expect(within(row).getByText('depotSystems.types.BMS')).toBeTruthy();
    expect(within(row).getByText('depotSystems.state.off')).toBeTruthy();
    expect(await within(row).findByText('North Depot')).toBeTruthy();
    expect((await screen.findAllByTitle(/\/vdv463$/)).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('v1.463.vdv.de').length).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: 'depotSystems.interfaceEnabled' })).toBeTruthy();
  });

  it('turns the interface off through the generic settings route after the confirmation', async () => {
    mockReads();
    putMock.mockResolvedValue({});
    wrap();
    fireEvent.click(await screen.findByRole('switch', { name: 'depotSystems.interfaceEnabled' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.toggleOff.confirm' }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/vdv463.enabled', { value: false });
    });
  });

  it('tells a site-restricted user that only all-site users manage them', () => {
    state.allSites = false;
    mockReads();
    wrap();
    expect(screen.getByText('depotSystems.allSitesOnly')).toBeTruthy();
    expect(getMock).not.toHaveBeenCalledWith('/v1/depot-systems');
  });

  it('creates a system with the proof and shows its password once', async () => {
    mockReads();
    postMock.mockResolvedValue({
      ...system,
      id: 'dms_2',
      presystemId: 'ITCS-1',
      password: 'S3cret-pw',
    });
    wrap();
    await screen.findByTestId('depot-system-row-dms_1');
    fireEvent.click(screen.getByRole('button', { name: 'depotSystems.create' }));
    const dialog = await screen.findByRole('dialog');
    // Only Depot sites are offered.
    expect(await within(dialog).findByLabelText('North Depot')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Main Lot')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('depotSystems.name'), {
      target: { value: 'City ITCS' },
    });
    fireEvent.change(within(dialog).getByLabelText('depotSystems.systemId'), {
      target: { value: 'bad id' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.create' }));
    expect(await within(dialog).findByText('depotSystems.presystemIdInvalid')).toBeTruthy();
    expect(within(dialog).getByText('depotSystems.depotsRequired')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('depotSystems.systemId'), {
      target: { value: 'ITCS-1' },
    });
    fireEvent.click(within(dialog).getByLabelText('North Depot'));
    fireEvent.change(within(dialog).getByLabelText('depotSystems.type'), {
      target: { value: 'ITCS' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.create' }));
    expect(await within(dialog).findByText('proof-missing')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'give-proof' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/depot-systems', {
        presystemId: 'ITCS-1',
        name: 'City ITCS',
        systemType: 'ITCS',
        siteIds: ['sit_depot'],
        infoIntervalSeconds: 30,
        requestTimeoutSeconds: 30,
        maxRetries: 3,
        keepaliveTimeoutSeconds: 180,
        proof: { kind: 'password', password: 'pw' },
      });
    });
    const shown = await screen.findByTestId<HTMLInputElement>('depot-password');
    expect(shown.value).toBe('S3cret-pw');
  });

  it('turns a system on only with the proof', async () => {
    mockReads();
    patchMock.mockResolvedValue({ ...system, isEnabled: true });
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    fireEvent.click(await screen.findByRole('switch', { name: 'depotSystems.enabled' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('depotSystems.enableTitle')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.enableConfirm' }));
    expect(await within(dialog).findByText('proof-missing')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'give-proof' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.enableConfirm' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/depot-systems/dms_1', {
        isEnabled: true,
        proof: { kind: 'password', password: 'pw' },
      });
    });
  });

  it('saves a name change without the proof and asks for it on a depot change', async () => {
    mockReads();
    patchMock.mockResolvedValue(system);
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    const name = await screen.findByLabelText('depotSystems.name');
    fireEvent.change(name, { target: { value: 'Depot North' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/depot-systems/dms_1', { name: 'Depot North' });
    });
    patchMock.mockClear();
    fireEvent.click(await screen.findByLabelText('South Depot'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('proof-missing')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('sets a new password with the proof and shows it once', async () => {
    mockReads();
    postMock.mockResolvedValue({ ...system, password: 'N3w-pw' });
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    fireEvent.click(await screen.findByRole('button', { name: 'depotSystems.replacePassword' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'give-proof' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.replacePassword' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/depot-systems/dms_1/password', {
        proof: { kind: 'password', password: 'pw' },
      });
    });
    expect((await screen.findByTestId<HTMLInputElement>('depot-password')).value).toBe('N3w-pw');
  });

  it('deletes with the proof', async () => {
    mockReads();
    deleteMock.mockResolvedValue({ id: 'dms_1', departuresReleased: 2 });
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    fireEvent.click(await screen.findByRole('button', { name: 'depotSystems.delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('depotSystems.deleteConfirm')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'give-proof' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'depotSystems.delete' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/depot-systems/dms_1', {
        proof: { kind: 'password', password: 'pw' },
      });
    });
    expect(toastMock).toHaveBeenCalledWith({
      title: 'depotSystems.deleted:count=2',
      variant: 'success',
    });
  });

  it('shows refused requests in plain words, the identifiers and the history', async () => {
    mockReads();
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    fireEvent.click(await screen.findByRole('tab', { name: 'depotSystems.tabs.refused' }));
    const refused = await screen.findByTestId('depot-refused-row');
    expect(within(refused).getByText('req-7')).toBeTruthy();
    expect(within(refused).getByText('depotSystems.refusals.vehicle_not_bus')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'depotSystems.tabs.identifiers' }));
    expect(await screen.findByText('CS-1/1, CS-1/2')).toBeTruthy();
    expect(screen.getByText('depotSystems.batteryMissing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'depotSystems.exportCsv' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'depotSystems.tabs.history' }));
    expect((await screen.findByTestId('history')).textContent).toBe('depot_system:dms_1');
  });

  it('says the bus identifiers are hidden when the reply has none (no fleets:read)', async () => {
    const withoutBuses = { depots: identifiers.depots, connection: identifiers.connection };
    mockReads({}, withoutBuses);
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    fireEvent.click(await screen.findByRole('tab', { name: 'depotSystems.tabs.identifiers' }));
    expect(await screen.findByText('CS-1/1, CS-1/2')).toBeTruthy();
    expect(screen.getByTestId('depot-buses-hidden').textContent).toBe('depotSystems.busesHidden');
    expect(screen.queryByText('VIN00000000000001')).toBeNull();
    expect(identifierCsvRows(withoutBuses)).toHaveLength(2);
  });

  it('offers no write controls without settings.integrations:write', async () => {
    state.canWrite = false;
    mockReads();
    wrap('/settings?tab=integrations&sub=depot-systems&depotSystem=dms_1');
    expect(await screen.findByRole('switch', { name: 'depotSystems.enabled' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'depotSystems.replacePassword' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
  });
});

describe('depot system helpers', () => {
  it('names every refusal reason in plain words in every locale', () => {
    const locales = { en, de, es, ko, zh, 'zh-TW': zhTW } as Record<string, unknown>;
    for (const [lang, locale] of Object.entries(locales)) {
      const refusals = (locale as { depotSystems: { refusals: Record<string, unknown> } })
        .depotSystems.refusals;
      expect(
        VDV463_REFUSAL_REASONS.filter((r) => typeof refusals[r] !== 'string'),
        lang,
      ).toEqual([]);
    }
  });

  it('builds one CSV row per charging point and bus', () => {
    expect(IDENTIFIER_CSV_HEADERS[0]).toBe('kind');
    expect(identifierCsvRows(identifiers)).toEqual([
      ['charging_point', 'sit_depot', 'North Depot', 'CS-1', 'CS-1/1', '', ''],
      ['charging_point', 'sit_depot', 'North Depot', 'CS-1', 'CS-1/2', '', ''],
      ['bus', '', '', '', '', 'VIN00000000000001', 'BUS-1'],
    ]);
  });

  it('checks the system ID like the API', () => {
    expect(isValidPresystemId('BMS-NORTH_1')).toBe(true);
    expect(isValidPresystemId('a b')).toBe(false);
    expect(isValidPresystemId('a:b')).toBe(false);
    expect(isValidPresystemId('')).toBe(false);
  });

  it('counts a system connected while its last message is within the keepalive time', () => {
    const now = Date.parse('2026-11-03T10:00:00.000Z');
    const on = { ...system, systemType: 'BMS' as const, isEnabled: true };
    expect(isConnectedNow({ ...on, lastMessageAt: '2026-11-03T09:58:00.000Z' }, now)).toBe(true);
    expect(isConnectedNow({ ...on, lastMessageAt: '2026-11-03T09:50:00.000Z' }, now)).toBe(false);
    expect(
      isConnectedNow({ ...on, isEnabled: false, lastMessageAt: '2026-11-03T09:59:00.000Z' }, now),
    ).toBe(false);
  });
});
