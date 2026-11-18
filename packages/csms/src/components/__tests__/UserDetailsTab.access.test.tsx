// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock, flags } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  flags: { fleetEnabled: true },
}));

vi.mock('@/lib/auth', () => ({
  useHasAllSiteAccess: () => true,
  useHasPermission: () => true,
  useAuth: (select: (s: Record<string, unknown>) => unknown) => select({ user: { id: 'usr_me' } }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, patch: patchMock } }));

import { UserDetailsTab } from '../user/UserDetailsTab';

const ROLES = [
  { id: 'rol_operator', name: 'operator', assignable: true },
  { id: 'rol_fleet', name: 'fleet_manager', assignable: true },
];

const BASE = {
  id: 'usr_1',
  email: 'op@example.com',
  firstName: 'Op',
  lastName: 'Erator',
  phone: null,
  isActive: true,
  hasAllSiteAccess: false,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const SITE_USER = { ...BASE, roleId: 'rol_operator', accessScope: 'sites', siteIds: ['sit_a'] };
const FLEET_USER = {
  ...BASE,
  roleId: 'rol_fleet',
  accessScope: 'fleets',
  siteIds: [],
  fleetIds: ['flt_1'],
};

function renderEdit(user: Record<string, unknown>, roles = ROLES): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/portal/features')
      return Promise.resolve({ fleetEnabled: flags.fleetEnabled });
    if (path === '/v1/fleets/flt_1') return Promise.resolve({ id: 'flt_1', name: 'Acme Vans' });
    if (path === '/v1/users/me/mfa') return Promise.resolve({ factorProofKinds: [] });
    return Promise.resolve({ data: [{ id: 'sit_a', name: 'Site A' }] });
  });
  patchMock.mockResolvedValue(user);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <UserDetailsTab user={user as never} userId="usr_1" roles={roles} canAdminister />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
  flags.fleetEnabled = true;
});

describe('UserDetailsTab: the role decides the access', () => {
  it('locks a Fleet Manager to Fleets and sends no unchanged role', async () => {
    renderEdit(FLEET_USER);
    const access = await screen.findByLabelText<HTMLSelectElement>('users.access.label');
    expect(access.value).toBe('fleets');
    expect(access.disabled).toBe(true);
    expect([...access.options].map((o) => o.value)).toEqual(['fleets']);
    expect(screen.getByText(/users\.access\.fleetManagerFleetsOnly/)).toBeTruthy();
    fireEvent.submit(access.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const body = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('roleId');
    expect(body).toMatchObject({ accessScope: 'fleets', fleetIds: ['flt_1'] });
  });

  it('offers a site role All Sites and Sites only', async () => {
    renderEdit(SITE_USER);
    const access = await screen.findByLabelText<HTMLSelectElement>('users.access.label');
    expect(access.disabled).toBe(false);
    expect([...access.options].map((o) => o.value)).toEqual(['all', 'sites']);
  });

  it('moves to Sites when the role changes from Fleet Manager, and to Fleets back', async () => {
    renderEdit(FLEET_USER);
    const access = await screen.findByLabelText<HTMLSelectElement>('users.access.label');
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_operator' } });
    await waitFor(() => {
      expect(access.value).toBe('sites');
    });
    expect(access.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_fleet' } });
    await waitFor(() => {
      expect(access.value).toBe('fleets');
    });
    expect(access.disabled).toBe(true);
  });

  it('sends Sites with the new role when a Fleet Manager becomes an Operator', async () => {
    renderEdit(FLEET_USER);
    await screen.findByLabelText('users.access.label');
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_operator' } });
    fireEvent.submit(screen.getByLabelText('users.role').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const body = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ roleId: 'rol_operator', accessScope: 'sites' });
    expect(body).not.toHaveProperty('fleetIds');
  });

  it('hides the Fleet Manager role while Fleets is off, but keeps it for a user who holds it', async () => {
    flags.fleetEnabled = false;
    renderEdit(SITE_USER, [
      { id: 'rol_operator', name: 'operator', assignable: true },
      { id: 'rol_fleet', name: 'fleet_manager', assignable: false },
    ]);
    await screen.findByLabelText('users.access.label');
    expect(screen.queryByRole('option', { name: 'users.roleNames.fleet_manager' })).toBeNull();
    cleanup();

    renderEdit(FLEET_USER, [
      { id: 'rol_operator', name: 'operator', assignable: true },
      { id: 'rol_fleet', name: 'fleet_manager', assignable: false },
    ]);
    expect(
      await screen.findByRole('option', { name: 'users.roleNames.fleet_manager' }),
    ).toBeTruthy();
  });
});
