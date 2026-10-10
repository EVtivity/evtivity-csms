// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }));

// Access to every site (useHasAllSiteAccess), set per test.
const siteAccess = vi.hoisted(() => ({ all: false }));
vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => siteAccess.all }));

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

const USER = {
  id: 'usr_1',
  email: 'op@example.com',
  firstName: 'Op',
  lastName: 'Erator',
  phone: null,
  roleId: 'rol_operator',
  isActive: true,
  hasAllSiteAccess: false,
  siteIds: ['sit_a'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function renderAndUncheckSite(): Promise<void> {
  getMock.mockResolvedValue({ data: [{ id: 'sit_a', name: 'Site A' }] });
  patchMock.mockResolvedValue(USER);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <UserDetailsTab
        user={USER}
        userId="usr_1"
        roles={[{ id: 'rol_operator', name: 'operator' }]}
        canAdminister
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
  const site = await screen.findByLabelText('Site A');
  fireEvent.click(site);
  fireEvent.submit(site.closest('form') as HTMLFormElement);
}

describe('UserDetailsTab site access', () => {
  afterEach(() => {
    cleanup();
    getMock.mockReset();
    patchMock.mockReset();
  });

  it('a site-restricted operator must keep at least one site', async () => {
    siteAccess.all = false;
    await renderAndUncheckSite();
    expect(await screen.findByText('users.siteAccessRequired')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('an all-site operator may remove every site', async () => {
    siteAccess.all = true;
    await renderAndUncheckSite();
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/users/usr_1',
        expect.objectContaining({ siteIds: [] }),
      );
    });
    expect(screen.queryByText('users.siteAccessRequired')).toBeNull();
  });
});
