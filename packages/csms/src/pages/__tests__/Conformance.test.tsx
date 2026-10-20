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

  it('starts an OCPP 2.0.1 run', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('conformance.ocppVersion'), {
      target: { value: 'ocpp2.0.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'conformance.runTests' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'conformance.runTests' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/octt/runs', {
        ocppVersion: 'ocpp2.0.1',
        sutType: 'csms',
      });
    });
  });

  it('shows the system under test of each run', async () => {
    const run = {
      ocppVersion: 'ocpp2.0.1',
      status: 'completed',
      totalTests: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      notApplicable: 0,
      durationMs: 10,
      createdAt: '2026-10-19T00:00:00Z',
    };
    getMock.mockResolvedValue({
      data: [
        { ...run, id: 1, sutType: 'cs' },
        { ...run, id: 2, sutType: 'csms' },
      ],
      total: 2,
    });
    renderPage();
    expect(
      within(await screen.findByTestId('conformance-run-row-1')).getByText('conformance.sutCs'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('conformance-run-row-2')).getByText('conformance.sutCsms'),
    ).toBeTruthy();
  });

  // Every version has a CSMS and a charging station suite.
  it('starts a charging station run for every version', async () => {
    renderPage();
    const versions = await screen.findByLabelText('conformance.ocppVersion');
    const values = within(versions)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['all', 'ocpp2.1', 'ocpp2.0.1', 'ocpp1.6']);
    for (const value of values) {
      cleanup();
      postMock.mockClear();
      renderPage();
      fireEvent.change(await screen.findByLabelText('conformance.systemUnderTest'), {
        target: { value: 'cs' },
      });
      fireEvent.change(screen.getByLabelText('conformance.ocppVersion'), {
        target: { value },
      });
      fireEvent.click(screen.getByRole('button', { name: 'conformance.runTests' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('conformance.startRunCsDescription')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'conformance.runTests' }));
      await waitFor(() => {
        expect(postMock).toHaveBeenCalledWith('/v1/octt/runs', {
          ocppVersion: value,
          sutType: 'cs',
        });
      });
    }
  });
});
