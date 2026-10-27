// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const { avatarState } = vi.hoisted(() => {
  const state: { value: unknown } = { value: null };
  return { avatarState: state };
});

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/v1/portal/driver/avatar') return Promise.resolve({ avatar: avatarState.value });
      if (url.endsWith('unread-count')) return Promise.resolve({ count: 0 });
      if (url === '/v1/portal/features') {
        return Promise.resolve({ reservationEnabled: true, supportEnabled: true });
      }
      return Promise.resolve([]);
    }),
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: unknown) => unknown) =>
    select({ driver: { firstName: 'Ana', lastName: 'Lee' } }),
}));
vi.mock('@/hooks/use-portal-events', () => ({ usePortalEvents: () => undefined }));
vi.mock('../AuthBranding', () => ({
  useAuthBranding: () => ({ companyName: null, companyLogo: null }),
}));
vi.mock('../NotificationDrawer', () => ({ NotificationDrawer: () => null }));

import { Layout } from '../Layout';

function renderLayout(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('Portal header avatar', () => {
  it("shows the driver's avatar in the account button once one is set", async () => {
    avatarState.value = {
      kind: 'generated',
      style: 'avataaars',
      seed: 'abc',
      options: { topVariant: 'bob' },
      updatedAt: null,
    };
    renderLayout();
    const account = await screen.findByLabelText('nav.account', { selector: 'button' });
    const img = await screen.findByAltText('account.avatarAlt');
    expect(account.contains(img)).toBe(true);
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('shows the initials without an avatar', async () => {
    avatarState.value = null;
    renderLayout();
    const account = await screen.findByLabelText('nav.account', { selector: 'button' });
    expect(account.textContent).toBe('AL');
  });
});
