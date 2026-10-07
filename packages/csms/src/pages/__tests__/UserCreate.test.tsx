// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { permissionCatalog } from '@evtivity/lib/permissions';

const { getMock, editorValues } = vi.hoisted(() => ({
  getMock: vi.fn(),
  editorValues: [] as string[][],
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
}));

vi.mock('@/components/PermissionEditor', () => ({
  PermissionEditor: ({ value }: { value: string[] }) => {
    editorValues.push(value);
    return null;
  },
}));

import { UserCreate } from '../UserCreate';

const ROLES = [
  { id: 'rol_admin', name: 'admin' },
  { id: 'rol_operator', name: 'operator' },
  { id: 'rol_viewer', name: 'viewer' },
];

function renderCreate(): void {
  getMock.mockImplementation((path: string) =>
    Promise.resolve(path === '/v1/roles' ? ROLES : { data: [] }),
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
});
