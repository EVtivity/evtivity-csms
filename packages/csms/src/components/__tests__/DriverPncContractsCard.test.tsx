// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, toastMock, state } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
  state: {
    canWrite: true,
    pncEnabled: true,
    contracts: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }));
// No settings permission: the card reads Plug & Charge from the public features endpoint.
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) =>
    permission === 'drivers:write' ? state.canWrite : false,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { DriverPncContractsCard } from '../driver/DriverPncContractsCard';

const ACTIVE = {
  id: 1,
  emaid: 'USEVTC12345678',
  pcid: 'WMIV0000001',
  status: 'active',
  createdAt: '2026-10-04T10:00:00Z',
  revokedAt: null,
};

function renderCard(): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/v1/portal/features' ? { pncEnabled: state.pncEnabled } : state.contracts,
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverPncContractsCard driverId="drv_1" timezone="UTC" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.canWrite = true;
  state.pncEnabled = true;
  state.contracts = [];
});

describe('DriverPncContractsCard', () => {
  it('is hidden when Plug & Charge is off and the driver has no contracts', async () => {
    state.pncEnabled = false;
    renderCard();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/drivers/drv_1/pnc-contracts');
    });
    expect(screen.queryByTestId('driver-pnc-contracts')).toBeNull();
  });

  it('shows the card from the public feature flags, without reading settings', async () => {
    renderCard();
    expect(await screen.findByTestId('driver-pnc-contracts')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/portal/features');
    expect(getMock).not.toHaveBeenCalledWith('/v1/settings');
  });

  it('lists contracts and revokes one after confirmation', async () => {
    state.contracts = [ACTIVE];
    postMock.mockResolvedValue({ ...ACTIVE, status: 'revoked' });
    renderCard();
    expect(await screen.findByText('USEVTC12345678')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'drivers.pncContractRevoke' }));
    const buttons = await screen.findAllByRole('button', { name: 'drivers.pncContractRevoke' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/pnc-contracts/1/revoke', {});
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'drivers.pncContractRevoked' }),
    );
  });

  it('creates a contract for a valid PCID only', async () => {
    postMock.mockResolvedValue(ACTIVE);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /drivers\.pncContractCreate/ }));
    const input = await screen.findByLabelText('drivers.pncPcid');
    fireEvent.change(input, { target: { value: 'bad pcid' } });
    expect(screen.getByText('drivers.pncPcidInvalid')).toBeTruthy();
    const confirm = () => {
      const buttons = screen.getAllByRole('button', { name: /drivers\.pncContractCreate/ });
      fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    };
    confirm();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'WMIV0000001' } });
    confirm();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/pnc-contracts', {
        pcid: 'WMIV0000001',
      });
    });
  });

  it('hides the actions without drivers:write', async () => {
    state.canWrite = false;
    state.contracts = [ACTIVE];
    renderCard();
    expect(await screen.findByText('USEVTC12345678')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /drivers\.pncContractCreate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'drivers.pncContractRevoke' })).toBeNull();
  });
});
