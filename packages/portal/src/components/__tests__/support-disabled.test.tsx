// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock },
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({ driver: { firstName: 'A', lastName: 'B', email: 'a@b.c' }, logout: vi.fn() }),
}));

vi.mock('@/lib/avatar', () => ({ useDriverAvatar: () => ({ data: undefined }) }));
vi.mock('@/components/account/DriverAvatar', () => ({ DriverAvatar: () => null }));

import { ReportIssue } from '../ReportIssue';
import { RequireSupport } from '../RequireSupport';
import { Account } from '../../pages/Account';

function renderWith(supportEnabled: boolean, ui: React.ReactNode, path = '/'): void {
  getMock.mockResolvedValue({ supportEnabled });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('support turned off in the portal', () => {
  it('hides the report-issue button', async () => {
    renderWith(false, <ReportIssue stationId="CS-1" />);
    await vi.waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/portal/features');
    });
    await vi.waitFor(() => {
      expect(screen.queryByText('supportCases.reportIssue')).toBeNull();
    });
  });

  it('shows the report-issue button while support is on', async () => {
    renderWith(true, <ReportIssue stationId="CS-1" />);
    expect(await screen.findByText('supportCases.reportIssue')).toBeDefined();
  });

  it('sends a direct visit of a support page home', async () => {
    renderWith(
      false,
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route element={<RequireSupport />}>
          <Route path="/support/new" element={<p>case form</p>} />
        </Route>
      </Routes>,
      '/support/new',
    );
    expect(await screen.findByText('home')).toBeDefined();
    expect(screen.queryByText('case form')).toBeNull();
  });

  it('opens support pages while support is on', async () => {
    renderWith(
      true,
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route element={<RequireSupport />}>
          <Route path="/support/new" element={<p>case form</p>} />
        </Route>
      </Routes>,
      '/support/new',
    );
    expect(await screen.findByText('case form')).toBeDefined();
  });

  it('leaves the support row out of the account page', async () => {
    renderWith(false, <Account />);
    expect(await screen.findByText('favorites.title')).toBeDefined();
    await vi.waitFor(() => {
      expect(screen.queryByText('account.supportCases')).toBeNull();
    });
  });

  it('lists the support row on the account page while support is on', async () => {
    renderWith(true, <Account />);
    expect(await screen.findByText('account.supportCases')).toBeDefined();
  });
});
