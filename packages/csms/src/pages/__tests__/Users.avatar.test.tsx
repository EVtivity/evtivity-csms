// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: vi.fn() } }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

import { UsersPage } from '../Users';

function user(id: string, avatar: unknown, firstName: string, lastName: string) {
  return {
    id,
    email: `${id}@example.com`,
    firstName,
    lastName,
    roleId: 'rol_operator',
    hasAllSiteAccess: true,
    siteCount: null,
    isActive: true,
    mustResetPassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    avatar,
  };
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('Users list avatars', () => {
  it('shows each user avatar beside the name, initials without one', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/v1/users?')
          ? {
              data: [
                user(
                  'usr_1',
                  { kind: 'generated', style: 'avataaars', seed: 'abc', options: {} },
                  'Ana',
                  'Lee',
                ),
                user('usr_2', null, 'Max', 'Roe'),
              ],
              total: 2,
            }
          : path === '/v1/roles'
            ? [{ id: 'rol_operator', name: 'operator' }]
            : { factorProofKinds: [] },
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <UsersPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const row1 = await screen.findByTestId('user-row-usr_1');
    const img = await within(row1).findByAltText('avatar.alt');
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    const row2 = screen.getByTestId('user-row-usr_2');
    expect(row2.querySelector('[role="img"]')?.textContent).toBe('MR');
  });
});
