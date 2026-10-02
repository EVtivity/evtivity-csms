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
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/error-message', () => ({ getErrorMessage: () => 'error' }));

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
    getMock.mockResolvedValue(DISABLED);
    renderCard('ocpp1.6');
    expect(await screen.findByText('stations.dynamicQrOcpp21Only')).toBeTruthy();
    expect(screen.queryByText('stations.dynamicQrEnable')).toBeNull();
  });

  it('enables dynamic QR codes with the entered validity and length', async () => {
    getMock.mockResolvedValue(DISABLED);
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
    getMock.mockResolvedValue(DISABLED);
    renderCard();

    fireEvent.change(await screen.findByLabelText('stations.dynamicQrValidity'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByText('stations.dynamicQrEnable'));

    expect(screen.getByText('stations.dynamicQrValidityRange')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('disables after confirmation', async () => {
    getMock.mockResolvedValue(ENABLED);
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
    getMock.mockResolvedValue(DISABLED);
    renderCard('ocpp2.1', false);
    const button = (await screen.findByText('stations.dynamicQrEnable')).closest('button');
    expect(button?.disabled).toBe(true);
    expect(screen.getByText('stations.dynamicQrOfflineHint')).toBeTruthy();
  });
});
