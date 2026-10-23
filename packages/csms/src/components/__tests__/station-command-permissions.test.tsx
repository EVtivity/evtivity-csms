// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station Commands panel hides what the user cannot send: the commands
// need the feature page's write permission on top of stations:write. The
// default operator role has no settings.firmware or settings.stationConfig
// permission.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

import { permissionCatalog } from '@evtivity/lib/permissions';
import { useAuth } from '@/lib/auth';
import { StationCommands } from '../StationCommands';

afterEach(() => {
  cleanup();
});

function renderCommands(permissions: string[], ocppProtocol = 'ocpp2.1'): void {
  useAuth.setState({ permissions });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StationCommands stationId="CS-1" ocppProtocol={ocppProtocol} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function advancedOptions(): string[] {
  const select = screen.getByLabelText('commands.action');
  return within(select)
    .getAllByRole('option')
    .map((o) => o.getAttribute('value') ?? '');
}

describe('StationCommands permissions', () => {
  it('hides firmware and configuration commands from the default operator role', () => {
    renderCommands(permissionCatalog.defaultsFor('operator'));
    expect(screen.getByText('commands.hiddenByPermission')).toBeDefined();
    expect(screen.getByRole('button', { name: 'commands.reset' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'commands.startTransaction' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'commands.setVariables' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'commands.updateFirmware' })).toBeNull();
    const options = advancedOptions();
    expect(options).toContain('Reset');
    expect(options).toContain('InstallCertificate');
    expect(options).not.toContain('SetNetworkProfile');
    expect(options).not.toContain('UpdateFirmware');
    // Vendor messages are station configuration.
    expect(options).not.toContain('DataTransfer');
    // Deny by default: tariffs need pricing:write (operators hold it).
    expect(options).toContain('SetDefaultTariff');
  });

  it('hides certificate, profile, reservation and session commands with stations:write alone', () => {
    renderCommands(['stations:read', 'stations:write'], 'ocpp1.6');
    expect(screen.getByRole('button', { name: 'commands.reset' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'commands.remoteStartTransaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'commands.changeConfiguration' })).toBeNull();
    const options = advancedOptions();
    for (const action of ['InstallCertificate', 'SetChargingProfile', 'ReserveNow']) {
      expect(options, action).not.toContain(action);
    }
  });

  it('offers the certificate signing trigger only with certificates:write', () => {
    renderCommands(['stations:read', 'stations:write']);
    fireEvent.click(screen.getByRole('button', { name: 'commands.triggerMessage' }));
    const dialog = screen.getByRole('dialog');
    const triggers = within(dialog)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(triggers).toContain('Heartbeat');
    expect(triggers).not.toContain('SignChargingStationCertificate');
  });

  it('shows every command and no note to a user with every permission', () => {
    renderCommands(permissionCatalog.defaultsFor('admin'));
    expect(screen.queryByText('commands.hiddenByPermission')).toBeNull();
    expect(screen.getByRole('button', { name: 'commands.setVariables' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'commands.updateFirmware' })).toBeDefined();
    expect(advancedOptions()).toContain('SetNetworkProfile');
  });
});
