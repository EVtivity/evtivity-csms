// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, access } = vi.hoisted(() => ({
  getMock: vi.fn(),
  access: { allSites: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => access.allSites }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

import { UsersPage } from '../Users';

function user(id: string, extra: Record<string, unknown>) {
  return {
    id,
    email: `${id}@example.com`,
    firstName: 'Ana',
    lastName: 'Lee',
    roleId: 'rol_operator',
    hasAllSiteAccess: false,
    siteCount: 2,
    isActive: true,
    mustResetPassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    avatar: null,
    ...extra,
  };
}

function renderPage(): void {
  getMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.startsWith('/v1/users?')
        ? {
            data: [
              user('usr_fleet', {
                accessScope: 'fleets',
                siteCount: 0,
                fleetCount: 2,
                fleetNames: ['Airport Shuttles', 'City Buses'],
              }),
              user('usr_site', { accessScope: 'sites', fleetCount: null, fleetNames: null }),
            ],
            total: 2,
          }
        : path === '/v1/roles'
          ? [{ id: 'rol_operator', name: 'operator' }]
          : { factorProofKinds: [] },
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  access.allSites = true;
});

describe('Users list fleet managers', () => {
  it('names the fleets of a fleet user in the access column', async () => {
    renderPage();
    const row = await screen.findByTestId('user-row-usr_fleet');
    const names = within(row).getByText('Airport Shuttles, City Buses');
    expect(names.getAttribute('title')).toBe('Airport Shuttles, City Buses');
    const site = screen.getByTestId('user-row-usr_site');
    expect(within(site).getByText('users.sitesCount')).toBeTruthy();
  });

  it('filters the list by access scope', async () => {
    renderPage();
    await screen.findByTestId('user-row-usr_fleet');
    const select = screen.getAllByLabelText('users.access.label')[0];
    if (select == null) throw new Error('no access filter');
    fireEvent.change(select, { target: { value: 'fleets' } });
    await waitFor(() => {
      expect(
        getMock.mock.calls.some(
          ([path]) => typeof path === 'string' && path.includes('accessScope=fleets'),
        ),
      ).toBe(true);
    });
  });

  it('offers no access filter to a site-restricted user', async () => {
    access.allSites = false;
    renderPage();
    await screen.findByTestId('user-row-usr_site');
    expect(screen.queryByLabelText('users.access.label')).toBeNull();
  });
});
