// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
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

const EVSES = [
  {
    evseId: 1,
    status: 'available',
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: 7.4,
        maxCurrentAmps: 32,
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

describe('ConnectorStatus connector type names', () => {
  it('shows the stored type by its display name', () => {
    renderTab();
    expect(screen.getByText('(Type 2)')).toBeTruthy();
  });

  it('offers J1772 and submits the stored value Type1', async () => {
    patchMock.mockResolvedValue({ evseId: 1, connectors: [] });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'stations.editEvse' }));
    const select = await screen.findByLabelText('stations.connectorType');
    const j1772 = within(select).getByRole('option', { name: 'J1772' });
    expect(j1772.getAttribute('value')).toBe('Type1');
    expect(
      within(select)
        .getByRole('option', { name: 'connectorTypeNames.other' })
        .getAttribute('value'),
    ).toBe('Unknown');
    expect(within(select).queryByRole('option', { name: /Type 1/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'Type1' } });
    fireEvent.submit(select.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/1', {
        connectors: [
          { connectorId: 1, connectorType: 'Type1', maxPowerKw: 7.4, maxCurrentAmps: 32 },
        ],
      });
    });
  });
});
