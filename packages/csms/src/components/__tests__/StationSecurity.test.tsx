// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock, postMock, toastMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return {
    patchMock: vi.fn(),
    postMock: vi.fn(),
    toastMock: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'profile' in opts ? `${key}:${String(opts['profile'])}` : key,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    patch: patchMock,
    post: postMock,
  },
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationSecurity } from '../StationSecurity';

function renderSecurity(overrides: Partial<Parameters<typeof StationSecurity>[0]> = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationSecurity
        stationId="CS-1"
        stationDbId="sta_1"
        securityProfile={1}
        pendingSecurityProfile={null}
        hasPassword
        isOnline
        timezone="UTC"
        ocppProtocol="ocpp2.1"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

const optionValues = (): { value: string; disabled: boolean }[] =>
  Array.from(screen.getByLabelText<HTMLSelectElement>(/stations.changeProfile/).options).map(
    (o) => ({ value: o.value, disabled: o.disabled }),
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationSecurity', () => {
  it('lets an OCPP 1.6 station change its profile over OCPP (profiles 0-2)', () => {
    renderSecurity({ ocppProtocol: 'ocpp1.6' });
    expect(optionValues().map((o) => o.value)).toEqual(['0', '1', '2']);
  });

  it('disables lower profiles while the station is online', () => {
    renderSecurity({ securityProfile: 2 });
    expect(optionValues()).toEqual([
      { value: '0', disabled: true },
      { value: '1', disabled: true },
      { value: '2', disabled: false },
      { value: '3', disabled: false },
    ]);
  });

  it('allows any profile while the station is offline (provisioning)', () => {
    renderSecurity({ securityProfile: 2, isOnline: false });
    expect(optionValues().every((o) => !o.disabled)).toBe(true);
  });

  it('shows a pending upgrade and cancels it by saving the current profile', async () => {
    patchMock.mockResolvedValueOnce({ pendingSecurityProfile: null });
    renderSecurity({ pendingSecurityProfile: 2 });

    expect(screen.getByText('stations.profileUpgradePending:2')).toBeTruthy();
    fireEvent.click(screen.getByText('stations.cancelProfileUpgrade'));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1', { securityProfile: 1 });
    });
  });

  it('rejects a password with characters OCPP does not allow', () => {
    renderSecurity();
    fireEvent.click(screen.getByText('stations.changePassword'));
    fireEvent.change(screen.getByLabelText('stations.newPassword'), {
      target: { value: 'has spaces in it 123' },
    });
    fireEvent.change(screen.getByLabelText('stations.confirmPassword'), {
      target: { value: 'has spaces in it 123' },
    });
    const saves = screen.getAllByText('stations.changePassword');
    fireEvent.click(saves[saves.length - 1] as HTMLElement);

    expect(screen.getByText('stations.passwordInvalidCharacters')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('generates a password that meets the OCPP rules', () => {
    renderSecurity();
    fireEvent.click(screen.getByText('stations.rotateCredentials'));
    const value = screen.getByLabelText<HTMLInputElement>('stations.newPassword').value;
    expect(value).toMatch(/^[a-zA-Z0-9]{20}$/);
  });
});
