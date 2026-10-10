// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, deleteMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, put: putMock, delete: deleteMock } }));
const permission = vi.hoisted(() => ({ canWrite: true }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/error-message', () => ({ getErrorMessage: () => 'error' }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

import { StationWebPaymentsCard } from '../station/StationWebPaymentsCard';

const DISABLED = {
  enabled: false,
  validitySeconds: null,
  totpLength: null,
  totpVersion: null,
  urlTemplate: null,
};
const ENABLED = {
  enabled: true,
  validitySeconds: 30,
  totpLength: 8,
  totpVersion: 'v1',
  urlTemplate: 'https://portal.example.com/qr/{chargingstationid}/{evse}/{totp}/{version}',
};

const NOT_CHECKED = {
  status: 'unknown',
  reason: 'not_checked',
  source: 'none',
  stationEnabled: null,
  checkedAt: null,
};
const SUPPORTED_LIVE = {
  status: 'supported',
  reason: 'reported',
  source: 'station',
  stationEnabled: false,
  checkedAt: '2026-10-09T12:00:00.000Z',
};
const NOT_SUPPORTED_LIVE = {
  status: 'not_supported',
  reason: 'unknown_component',
  source: 'station',
  stationEnabled: null,
  checkedAt: '2026-10-09T12:00:00.000Z',
};

function mockGet(
  config: typeof DISABLED | typeof ENABLED,
  stored: Record<string, unknown> = NOT_CHECKED,
  live: Record<string, unknown> = SUPPORTED_LIVE,
): void {
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/web-payments')) return Promise.resolve(config);
    if (url.endsWith('/support?live=false')) return Promise.resolve(stored);
    if (url.endsWith('/support?live=true')) return Promise.resolve(live);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderCard(ocppProtocol: string | null = 'ocpp2.1', isOnline = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationWebPaymentsCard stationId="sta_1" ocppProtocol={ocppProtocol} isOnline={isOnline} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationWebPaymentsCard', () => {
  it('explains that OCPP 1.6 stations are not supported', async () => {
    mockGet(DISABLED);
    renderCard('ocpp1.6');
    expect(await screen.findByText('stations.dynamicQrOcpp21Only')).toBeTruthy();
    expect(screen.queryByText('stations.dynamicQrEnable')).toBeNull();
  });

  it('enables dynamic QR codes with the entered validity and length', async () => {
    mockGet(DISABLED);
    putMock.mockResolvedValue(ENABLED);
    renderCard();

    fireEvent.change(await screen.findByLabelText('stations.dynamicQrValidity'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByText('stations.dynamicQrEnable'));

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/web-payments', {
        validitySeconds: 30,
        totpLength: 8,
      });
    });
    expect(await screen.findByText(ENABLED.urlTemplate)).toBeTruthy();
  });

  it('refuses a validity outside 6 to 3600 seconds', async () => {
    mockGet(DISABLED);
    renderCard();

    fireEvent.change(await screen.findByLabelText('stations.dynamicQrValidity'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByText('stations.dynamicQrEnable'));

    expect(screen.getByText('stations.dynamicQrValidityRange')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('disables after confirmation', async () => {
    mockGet(ENABLED);
    deleteMock.mockResolvedValue(DISABLED);
    renderCard();

    fireEvent.click(await screen.findByText('stations.dynamicQrDisable'));
    const buttons = await screen.findAllByText('stations.dynamicQrDisable');
    const confirm = buttons[buttons.length - 1];
    if (confirm == null) throw new Error('confirm button not found');
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/stations/sta_1/web-payments');
    });
  });

  it('disables the enable button while the station is offline', async () => {
    mockGet(DISABLED);
    renderCard('ocpp2.1', false);
    const button = (await screen.findByText('stations.dynamicQrEnable')).closest('button');
    expect(button?.disabled).toBe(true);
    expect(screen.getByText('stations.dynamicQrOfflineHint')).toBeTruthy();
  });

  it('states the hardware requirement and shows a not checked result', async () => {
    mockGet(DISABLED);
    renderCard();
    expect(await screen.findByText('stations.dynamicQrReasonNotChecked')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrRequirement')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrSupportUnknown')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/stations/sta_1/web-payments/support?live=false');
  });

  it('does not ask an OCPP 1.6 station for support', async () => {
    mockGet(DISABLED);
    renderCard('ocpp1.6');
    await screen.findByText('stations.dynamicQrOcpp21Only');
    expect(screen.queryByText('stations.dynamicQrCheckSupport')).toBeNull();
    expect(getMock).not.toHaveBeenCalledWith('/v1/stations/sta_1/web-payments/support?live=false');
  });

  it('checks support live and shows a supported station', async () => {
    mockGet(DISABLED);
    renderCard();
    fireEvent.click(await screen.findByText('stations.dynamicQrCheckSupport'));
    expect(await screen.findByText('stations.dynamicQrSupported')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrReasonReported')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrCheckedLive')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/stations/sta_1/web-payments/support?live=true');
    const enable = screen.getByText('stations.dynamicQrEnable').closest('button');
    expect(enable?.disabled).toBe(false);
  });

  it('disables Enable when the station does not support dynamic QR codes', async () => {
    mockGet(DISABLED, NOT_CHECKED, NOT_SUPPORTED_LIVE);
    renderCard();
    fireEvent.click(await screen.findByText('stations.dynamicQrCheckSupport'));
    expect(await screen.findByText('stations.dynamicQrNotSupported')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrReasonUnknownComponent')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrNotSupportedHint')).toBeTruthy();
    const enable = screen.getByText('stations.dynamicQrEnable').closest('button');
    expect(enable?.disabled).toBe(true);
  });

  it('shows a stored device model result on load', async () => {
    mockGet(ENABLED, { ...SUPPORTED_LIVE, source: 'device_model' });
    renderCard();
    expect(await screen.findByText('stations.dynamicQrCheckedReport')).toBeTruthy();
    expect(screen.getByText('stations.dynamicQrSupported')).toBeTruthy();
  });

  it('hides Check support without stations:write, since it sends a command', async () => {
    permission.canWrite = false;
    try {
      mockGet(DISABLED);
      renderCard();
      expect(await screen.findByText('stations.dynamicQrReasonNotChecked')).toBeTruthy();
      expect(screen.queryByText('stations.dynamicQrCheckSupport')).toBeNull();
    } finally {
      permission.canWrite = true;
    }
  });

  it('disables Check support while the station is offline', async () => {
    mockGet(DISABLED, { ...NOT_CHECKED, reason: 'offline' });
    renderCard('ocpp2.1', false);
    expect(await screen.findByText('stations.dynamicQrReasonOffline')).toBeTruthy();
    const check = screen.getByText('stations.dynamicQrCheckSupport').closest('button');
    expect(check?.disabled).toBe(true);
  });
});
