// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, toastMock } = vi.hoisted(() => ({ postMock: vi.fn(), toastMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
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
  return { api: { get: vi.fn(), post: postMock, patch: vi.fn(), delete: vi.fn() }, ApiError };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));

import { ApiError } from '@/lib/api';
import { ConnectorStatus } from '../charts/ConnectorStatus';

const EVSES = [
  {
    evseId: 1,
    status: 'available',
    connectors: [
      {
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: 50,
        status: 'occupied',
        isIdling: false,
      },
    ],
  },
];

function renderTab(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={EVSES as never}
        stationId="sta_1"
        stationOcppId="CS-0001"
        ocppProtocol="ocpp2.1"
        isOnline
        isSimulator
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectorStatus simulator actions', () => {
  it('Unplug sends the action and refreshes the connectors the station page shows', async () => {
    postMock.mockResolvedValue({ commandId: 'c1' });
    const queryClient = renderTab();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'stations.simUnplug' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/css/actions/unplug', {
        stationId: 'CS-0001',
        evseId: 1,
      });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['stations', 'sta_1', 'connectors'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['stations', 'sta_1'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['station', 'sta_1', 'connectors'] });
  });

  it('a refused action shows the API reason', async () => {
    postMock.mockRejectedValue(
      new ApiError(400, { error: 'Authorization rejected', code: 'CSS_ACTION_REJECTED' }),
    );
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'stations.simPlugIn' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'Authorization rejected',
      });
    });
  });
});
