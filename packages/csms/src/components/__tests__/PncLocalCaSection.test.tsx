// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, toastMock, state } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
  state: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => state.canWrite }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { PncLocalCaSection } from '../settings/PncLocalCaSection';

const CONFIGURED = {
  configured: true,
  createdAt: '2026-10-04T10:00:00Z',
  certificates: [
    {
      schema: 2,
      role: 'moRoot',
      subject: 'CN=EVtivity MO Root, O=EVtivity',
      serialNumber: '01',
      validFrom: '2026-10-04T10:00:00Z',
      validTo: '2066-10-04T10:00:00Z',
    },
  ],
};

function renderSection(onCountry = vi.fn(), onProvider = vi.fn()): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PncLocalCaSection
        emaidCountry="US"
        emaidProviderId="EVT"
        onEmaidCountryChange={onCountry}
        onEmaidProviderIdChange={onProvider}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.canWrite = true;
});

describe('PncLocalCaSection', () => {
  it('creates the CA after confirmation and shows its certificates', async () => {
    getMock.mockResolvedValue({ configured: false, createdAt: null, certificates: [] });
    postMock.mockResolvedValue(CONFIGURED);
    renderSection();
    expect(await screen.findByText('settings.pncLocalCaNotConfigured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /settings\.pncLocalCaCreate/ }));
    const buttons = await screen.findAllByRole('button', { name: /settings\.pncLocalCaCreate/ });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/pnc/settings/local-ca', {});
    });
    expect(await screen.findByText('CN=EVtivity MO Root, O=EVtivity')).toBeTruthy();
    expect(screen.getByText('settings.pncLocalCaRoles.moRoot')).toBeTruthy();
  });

  it('offers no create button once the CA exists or without write permission', async () => {
    getMock.mockResolvedValue(CONFIGURED);
    renderSection();
    expect(await screen.findByText('settings.pncLocalCaConfigured')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /settings\.pncLocalCaCreate/ })).toBeNull();
    cleanup();
    state.canWrite = false;
    getMock.mockResolvedValue({ configured: false, createdAt: null, certificates: [] });
    renderSection();
    expect(await screen.findByText('settings.pncLocalCaNotConfigured')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /settings\.pncLocalCaCreate/ })).toBeNull();
  });

  it('upper-cases the eMAID prefix input', async () => {
    getMock.mockResolvedValue(CONFIGURED);
    const onCountry = vi.fn();
    const onProvider = vi.fn();
    renderSection(onCountry, onProvider);
    fireEvent.change(await screen.findByLabelText('settings.pncEmaidCountry'), {
      target: { value: 'de' },
    });
    fireEvent.change(screen.getByLabelText('settings.pncEmaidProviderId'), {
      target: { value: 'ab1' },
    });
    expect(onCountry).toHaveBeenCalledWith('DE');
    expect(onProvider).toHaveBeenCalledWith('AB1');
  });
});
