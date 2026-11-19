// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { FLEET_MANAGER_DEFAULTS, FLEET_USER_PERMISSIONS } from '@evtivity/lib/permissions';

const { getMock, postMock, editorProps, state, roleOverride } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  editorProps: [] as { value: string[]; allowed?: readonly string[] | undefined }[],
  state: { allSites: true, fleetEnabled: true },
  roleOverride: { value: null as null | { id: string; name: string; assignable: boolean }[] },
}));

vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => state.allSites }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
}));
vi.mock('@/components/PermissionEditor', () => ({
  PermissionEditor: (props: { value: string[]; allowed?: readonly string[] }) => {
    editorProps.push(props);
    return null;
  },
}));

import { UserCreate } from '../UserCreate';

const ROLES = [
  { id: 'rol_operator', name: 'operator' },
  { id: 'rol_viewer', name: 'viewer' },
  { id: 'rol_fleet', name: 'fleet_manager' },
];

function renderCreate(entry = '/users/new'): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/roles') return Promise.resolve(roleOverride.value ?? ROLES);
    if (path === '/v1/users/me/mfa') return Promise.resolve({ factorProofKinds: [] });
    if (path === '/v1/portal/features') {
      return Promise.resolve({ fleetEnabled: state.fleetEnabled });
    }
    if (path === '/v1/fleets/flt_7') return Promise.resolve({ id: 'flt_7', name: 'Harbor Vans' });
    if (path.startsWith('/v1/fleets')) {
      return Promise.resolve({ data: [{ id: 'flt_1', name: 'Acme Vans' }] });
    }
    return Promise.resolve({ data: [{ id: 'sit_1', name: 'Depot' }] });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <UserCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  editorProps.length = 0;
  state.allSites = true;
  state.fleetEnabled = true;
  roleOverride.value = null;
});

describe('UserCreate fleet users', () => {
  it('makes a fleet user when the Fleet Manager role is picked, with the fleet permissions only', async () => {
    postMock.mockResolvedValue({ id: 'usr_9' });
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.fleet_manager' });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_fleet' } });

    const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
    await waitFor(() => {
      expect(access.value).toBe('fleets');
    });
    await waitFor(() => {
      expect(editorProps.at(-1)?.allowed).toEqual(FLEET_USER_PERMISSIONS);
    });
    // The role defaults: every fleet user permission but the billing profile.
    expect([...(editorProps.at(-1)?.value ?? [])].sort()).toEqual(
      [...FLEET_MANAGER_DEFAULTS].sort(),
    );

    fireEvent.change(screen.getByLabelText('fleets.searchFleets'), { target: { value: 'Acme' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Acme Vans' }, { timeout: 2000 }));
    expect(await screen.findByText('Acme Vans')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'f@b.example' } });
    fireEvent.change(screen.getByLabelText('users.firstName'), { target: { value: 'F' } });
    fireEvent.change(screen.getByLabelText('users.lastName'), { target: { value: 'M' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['accessScope']).toBe('fleets');
    expect(body['fleetIds']).toEqual(['flt_1']);
    expect(body).not.toHaveProperty('hasAllSiteAccess');
    expect(body).not.toHaveProperty('siteIds');
  });

  it('opens with the Fleet Manager role and the fleet a fleet page link names', async () => {
    postMock.mockResolvedValue({ id: 'usr_9' });
    renderCreate('/users/new?role=fleet_manager&fleetId=flt_7');
    const role = screen.getByLabelText<HTMLSelectElement>('users.role');
    await waitFor(() => {
      expect(role.value).toBe('rol_fleet');
    });
    expect(screen.getByLabelText<HTMLSelectElement>('users.access.label').value).toBe('fleets');
    expect(await screen.findByText('Harbor Vans')).toBeTruthy();
    await waitFor(() => {
      expect(editorProps.at(-1)?.allowed).toEqual(FLEET_USER_PERMISSIONS);
    });
    fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'h@b.example' } });
    fireEvent.change(screen.getByLabelText('users.firstName'), { target: { value: 'H' } });
    fireEvent.change(screen.getByLabelText('users.lastName'), { target: { value: 'V' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ roleId: 'rol_fleet', accessScope: 'fleets', fleetIds: ['flt_7'] });
  });

  it('keeps Access disabled with a helper and hides the permissions until a role is picked', async () => {
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.operator' });
    const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
    expect(access.disabled).toBe(true);
    expect(screen.getByText('users.access.pickRoleFirst')).toBeTruthy();
    expect(screen.queryByText('users.permissions')).toBeNull();
    expect(editorProps).toHaveLength(0);
    const role = screen.getByLabelText('users.role');
    // The Role field comes before Access.
    expect(role.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['rol_operator', 'rol_viewer'])(
    'gives the %s role All Sites and Sites only, with every permission of the list',
    async (roleId) => {
      renderCreate();
      await screen.findByRole('option', { name: 'users.roleNames.operator' });
      fireEvent.change(screen.getByLabelText('users.role'), { target: { value: roleId } });
      const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
      await waitFor(() => {
        expect(access.disabled).toBe(false);
      });
      const options = [...access.options].map((o) => o.value);
      expect(options).toEqual(['all', 'sites']);
      expect(access.value).toBe('sites');
      await waitFor(() => {
        expect(editorProps.at(-1)?.allowed).toBeUndefined();
      });
    },
  );

  it('locks Access to Fleets for the Fleet Manager role, with a helper', async () => {
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.fleet_manager' });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_fleet' } });
    const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
    await waitFor(() => {
      expect(access.value).toBe('fleets');
    });
    expect(access.disabled).toBe(true);
    expect([...access.options].map((o) => o.value)).toEqual(['fleets']);
    expect(screen.getByText(/users\.access\.fleetManagerFleetsOnly/)).toBeTruthy();
  });

  it('goes back to Sites with the role defaults and no fleet when another role replaces Fleet Manager', async () => {
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.fleet_manager' });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_fleet' } });
    fireEvent.change(screen.getByLabelText('fleets.searchFleets'), { target: { value: 'Acme' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Acme Vans' }, { timeout: 2000 }));
    expect(await screen.findByText('Acme Vans')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_operator' } });
    const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
    await waitFor(() => {
      expect(access.value).toBe('sites');
    });
    await waitFor(() => {
      expect(editorProps.at(-1)?.allowed).toBeUndefined();
    });
    expect(editorProps.at(-1)?.value).toContain('stations:read');
    expect(screen.queryByText('Acme Vans')).toBeNull();

    // Back to Fleet Manager: Fleets and the role defaults again, the fleet list empty.
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_fleet' } });
    await waitFor(() => {
      expect(access.value).toBe('fleets');
    });
    // The role defaults: every fleet user permission but the billing profile.
    expect([...(editorProps.at(-1)?.value ?? [])].sort()).toEqual(
      [...FLEET_MANAGER_DEFAULTS].sort(),
    );
    expect(screen.getByText('users.access.noFleetsPicked')).toBeTruthy();
  });

  it('keeps the site access chosen when one site role replaces another', async () => {
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.operator' });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_operator' } });
    const access = screen.getByLabelText<HTMLSelectElement>('users.access.label');
    await waitFor(() => {
      expect(access.disabled).toBe(false);
    });
    fireEvent.change(access, { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_viewer' } });
    await waitFor(() => {
      expect(editorProps.at(-1)?.value).not.toContain('stations:write');
    });
    expect(access.value).toBe('all');
  });

  it('leaves out a Fleet Manager role the API marks unassignable', async () => {
    roleOverride.value = [
      { id: 'rol_operator', name: 'operator', assignable: true },
      { id: 'rol_fleet', name: 'fleet_manager', assignable: false },
    ];
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.operator' });
    expect(screen.queryByRole('option', { name: 'users.roleNames.fleet_manager' })).toBeNull();
  });

  it('offers neither Fleets nor the Fleet Manager role to a site-restricted user', async () => {
    state.allSites = false;
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.viewer' });
    expect(screen.queryByRole('option', { name: 'users.roleNames.fleet_manager' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'users.access.fleets' })).toBeNull();
  });

  it('offers neither while the Fleets feature is off', async () => {
    state.fleetEnabled = false;
    renderCreate();
    await screen.findByRole('option', { name: 'users.roleNames.viewer' });
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'users.roleNames.fleet_manager' })).toBeNull();
    });
    expect(screen.queryByRole('option', { name: 'users.access.fleets' })).toBeNull();
  });
});
