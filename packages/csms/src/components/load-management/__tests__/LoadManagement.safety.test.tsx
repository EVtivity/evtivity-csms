// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { LoadManagement } from '../LoadManagement';

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LoadManagement siteId="site1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOTICE = 'load-management-safety-notice';

describe('LoadManagement electrical safety notice', () => {
  it('shows the warning while load management is enabled', async () => {
    apiMock.get.mockResolvedValue({
      config: { strategy: 'equal_share', isEnabled: true },
      hierarchy: [],
      stations: [],
    });
    renderTab();

    const notice = await screen.findByTestId(NOTICE);
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.className).toContain('text-warning-text');
    expect(notice.textContent).toContain('loadManagement.electricalSafetyTitle');
    expect(notice.textContent).toContain('loadManagement.electricalSafetyBody');
    // Not dismissible: the notice has no close button.
    expect(notice.querySelector('button')).toBeNull();
  });

  it('places the warning first in the panel, before the strategy and the Save button', async () => {
    apiMock.get.mockResolvedValue({
      config: { strategy: 'equal_share', isEnabled: true },
      hierarchy: [],
      stations: [],
    });
    renderTab();

    const notice = await screen.findByTestId(NOTICE);
    const form = notice.closest('form');
    expect(form).not.toBeNull();
    expect(form?.firstElementChild).toBe(notice);
    const strategy = screen.getByLabelText('loadManagement.allocationStrategy');
    expect(
      notice.compareDocumentPosition(strategy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides the warning while load management is disabled', async () => {
    apiMock.get.mockResolvedValue({
      config: { strategy: 'equal_share', isEnabled: false },
      hierarchy: [],
      stations: [],
    });
    renderTab();

    await screen.findByText('loadManagement.noPanels');
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('shows the warning as soon as the operator checks Enable Load Management', async () => {
    apiMock.get.mockResolvedValue({ config: null, hierarchy: [], stations: [] });
    renderTab();

    await screen.findByText('loadManagement.noPanels');
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    fireEvent.click(screen.getByLabelText('loadManagement.enableLoadManagement'));
    expect(screen.getByTestId(NOTICE)).toBeTruthy();
  });
});
