// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => true,
  useHasAllSiteAccess: () => true,
  useHasCompanyWidePermission: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { IntegrationsSettings } from '../IntegrationsSettings';

function setup(settings: Record<string, unknown>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/settings?sub=fleet']}>
      <QueryClientProvider client={client}>
        <IntegrationsSettings settings={settings} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.get.mockResolvedValue({});
  apiMock.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Fleet Charging switch', () => {
  it('turns fleetCharging.enabled on at once', async () => {
    setup({ 'fleet.enabled': true, 'fleetCharging.enabled': false });
    const toggle = await screen.findByRole('switch', { name: 'settings.fleetChargingEnabled' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/fleetCharging.enabled', {
        value: true,
      });
    });
  });

  it('puts the switch back and says why when the save fails', async () => {
    apiMock.put.mockRejectedValue(new Error('offline'));
    setup({ 'fleet.enabled': true, 'fleetCharging.enabled': false });
    const toggle = await screen.findByRole('switch', { name: 'settings.fleetChargingEnabled' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('asks before turning it off and says what stops', async () => {
    setup({ 'fleet.enabled': true, 'fleetCharging.enabled': true });
    const toggle = await screen.findByRole('switch', { name: 'settings.fleetChargingEnabled' });
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('settings.fleetChargingEnabledOff')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.toggleOff.confirm' }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/fleetCharging.enabled', {
        value: false,
      });
    });
  });
});
