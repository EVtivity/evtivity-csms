// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string | number }) =>
      opts?.value != null ? `${key} ${String(opts.value)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: patchMock, delete: vi.fn() },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/ocpp-command-access', () => ({ useCanSendOcppCommand: () => () => true }));

import { ConnectorStatus } from '../charts/ConnectorStatus';
import { ratingField } from '@/lib/connector-rating';

const EVSES = [
  {
    evseId: 1,
    status: 'available',
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: 7.4,
        maxCurrentAmps: 31.5,
        status: 'available',
        isIdling: false,
      },
    ],
  },
];

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={EVSES as never}
        stationId="sta_1"
        stationOcppId="CS-0001"
        ocppProtocol="ocpp2.1"
        isOnline
        isSimulator={false}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectorStatus decimal ratings', () => {
  it('shows a decimal power and current', () => {
    renderTab();
    expect(screen.getByText('charts.powerValue 7.4')).toBeTruthy();
    expect(screen.getByText('charts.currentValue 31.5')).toBeTruthy();
  });

  it('edits an EVSE with decimal power and current', async () => {
    patchMock.mockResolvedValue({ evseId: 1, connectors: [] });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'stations.editEvse' }));
    const power = await screen.findByLabelText('stations.maxPower');
    const current = screen.getByLabelText('stations.maxCurrent');
    expect((power as HTMLInputElement).value).toBe('7.4');
    expect((current as HTMLInputElement).value).toBe('31.5');
    fireEvent.change(power, { target: { value: '11.5' } });
    fireEvent.change(current, { target: { value: '16.5' } });
    fireEvent.submit(power.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/1', {
        connectors: [
          { connectorId: 1, connectorType: 'Type2', maxPowerKw: 11.5, maxCurrentAmps: 16.5 },
        ],
      });
    });
  });
});

describe('ratingField', () => {
  it('holds a reported rating at the decimals the API takes', () => {
    expect(ratingField(3.6805, 2)).toBe('3.68');
    expect(ratingField(31.5, 1)).toBe('31.5');
    expect(ratingField(22, 2)).toBe('22');
    expect(ratingField(null, 1)).toBe('');
  });
});
