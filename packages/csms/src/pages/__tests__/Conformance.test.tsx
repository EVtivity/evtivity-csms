// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => {
  // The theme store reads matchMedia when the app modules load; jsdom has none.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return { getMock: vi.fn(), postMock: vi.fn() };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, useHasCompanyWidePermission: () => true };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});

import { Conformance } from '../Conformance';

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Conformance />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Conformance page', () => {
  beforeEach(() => {
    getMock.mockResolvedValue({ data: [], total: 0 });
    postMock.mockResolvedValue({ id: 1, status: 'pending' });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('warns to run conformance tests in a test environment', async () => {
    renderPage();
    const warning = await screen.findByTestId('conformance-environment-warning');
    expect(warning.textContent).toContain('conformance.environmentWarning');
  });

  it('asks for confirmation with the warning before starting a run', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'conformance.runTests' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('conformance.startRunTitle')).toBeTruthy();
    expect(within(dialog).getByTestId('conformance-environment-warning')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'conformance.runTests' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/octt/runs', {
        ocppVersion: 'all',
        sutType: 'csms',
      });
    });
  });

  it('starts no run when the confirmation is cancelled', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'conformance.runTests' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    expect(postMock).not.toHaveBeenCalled();
  });
});
