// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { permissionCatalog } from '@evtivity/lib/permissions';

const { getMock, postMock, putMock, editorValues } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  editorValues: [] as string[][],
}));

// Access to every site (useHasAllSiteAccess), set per test.
const siteAccess = vi.hoisted(() => ({ all: true }));
vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => siteAccess.all }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: putMock },
  getApiErrorFieldDetails: () => ({}),
}));

vi.mock('@/components/PermissionEditor', () => ({
  PermissionEditor: ({ value }: { value: string[] }) => {
    editorValues.push(value);
    return null;
  },
}));

// The proof field: a stand-in that reports a password proof when its button is pressed.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({ onChange }: { onChange: (p: unknown) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange({ kind: 'password', password: 'secret' });
      }}
    >
      give-proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { UserCreate } from '../UserCreate';

const ROLES = [
  { id: 'rol_admin', name: 'admin' },
  { id: 'rol_operator', name: 'operator' },
  { id: 'rol_viewer', name: 'viewer' },
];

function renderCreate(proofKinds: string[] = []): void {
  getMock.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/v1/roles'
        ? ROLES
        : path === '/v1/users/me/mfa'
          ? { factorProofKinds: proofKinds, mfaMethod: null }
          : { data: [] },
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UserCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function selectRole(roleId: string): Promise<string[]> {
  await screen.findByRole('option', { name: 'viewer' });
  fireEvent.change(screen.getByLabelText('users.role'), { target: { value: roleId } });
  let last: string[] = [];
  await waitFor(() => {
    last = editorValues.at(-1) ?? [];
    expect(last.length).toBeGreaterThan(0);
  });
  return last;
}

describe('UserCreate role defaults', () => {
  afterEach(() => {
    cleanup();
    getMock.mockReset();
    editorValues.length = 0;
  });

  it.each(['admin', 'operator', 'viewer'])(
    'starts a new %s with the server defaults of the role',
    async (role) => {
      renderCreate();
      const value = await selectRole(`rol_${role}`);
      expect(value).toEqual(permissionCatalog.defaultsFor(role));
    },
  );

  it('does not give an operator write access to conformance, reports, logs, sustainability or audit', async () => {
    renderCreate();
    const value = await selectRole('rol_operator');
    for (const p of [
      'conformance:write',
      'reports:write',
      'logs:write',
      'sustainability:write',
      'audit:write',
    ]) {
      expect(value).not.toContain(p);
    }
    expect(value.some((p) => p.startsWith('settings.'))).toBe(false);
  });

  it('does not fetch /v1/permissions to build the defaults', async () => {
    renderCreate();
    await selectRole('rol_viewer');
    expect(getMock).not.toHaveBeenCalledWith('/v1/permissions');
  });

  it('shows the all-site toggle to an all-site user only', async () => {
    siteAccess.all = true;
    renderCreate();
    expect(await screen.findByText('users.allSites')).toBeTruthy();
    cleanup();

    siteAccess.all = false;
    renderCreate();
    await screen.findByRole('option', { name: 'viewer' });
    expect(screen.queryByText('users.allSites')).toBeNull();
    siteAccess.all = true;
  });
});

describe('UserCreate fresh proof', () => {
  afterEach(() => {
    cleanup();
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
    editorValues.length = 0;
  });

  function fill(): void {
    fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'a@b.example' } });
    fireEvent.change(screen.getByLabelText('users.firstName'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('users.lastName'), { target: { value: 'B' } });
    fireEvent.click(screen.getByLabelText('users.allSites'));
  }

  it('sends an admin with its permissions and the proof in one request', async () => {
    postMock.mockResolvedValue({ id: 'usr_1' });
    renderCreate(['password']);
    await selectRole('rol_admin');
    fill();
    const create = screen.getByRole('button', { name: 'common.create' });
    fireEvent.click(create);
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('give-proof'));
    fireEvent.click(create);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['permissions']).toEqual(permissionCatalog.defaultsFor('admin'));
    expect(body['proof']).toEqual({ kind: 'password', password: 'secret' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('asks no proof for a viewer', async () => {
    postMock.mockResolvedValue({ id: 'usr_2' });
    renderCreate(['password']);
    await selectRole('rol_viewer');
    fill();
    expect(screen.queryByText('give-proof')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    expect((postMock.mock.calls[0]?.[1] as Record<string, unknown>)['proof']).toBeUndefined();
  });
});
