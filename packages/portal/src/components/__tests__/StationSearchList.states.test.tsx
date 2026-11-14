// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station search: keyboard reachable rows, and the loading, empty and
// error states of a search.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count != null ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'en' },
  }),
}));

import { StationSearchList } from '../StationSearchList';

const row = {
  stationId: 'CS-0001',
  model: null,
  isOnline: true,
  siteName: 'Office',
  siteAddress: null,
  siteCity: null,
  evseCount: 2,
  availableCount: 1,
  connectors: [{ connectorType: 'Type2', maxPowerKw: 22, maxCurrentAmps: 32, status: 'available' }],
  unitId: null,
  unitName: null,
};

function renderList(onSelect = vi.fn()): ReturnType<typeof vi.fn> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StationSearchList onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSelect;
}

function search(text: string): void {
  fireEvent.change(screen.getByPlaceholderText('chargerSearch.searchPlaceholder'), {
    target: { value: text },
  });
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('StationSearchList', () => {
  it('makes each result a keyboard button that Enter and Space select', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/v1/portal/chargers/search') ? [row] : {}),
    );
    const onSelect = renderList();
    search('CS');
    const result = await screen.findByTestId('search-row');
    expect(result.getAttribute('role')).toBe('button');
    expect(result.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(result, { key: 'Enter' });
    fireEvent.keyDown(result, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('CS-0001', null);
  });

  it('says no station was found for a search without results', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/v1/portal/chargers/search') ? [] : {}),
    );
    renderList();
    search('zzz');
    expect((await screen.findByTestId('empty-state')).textContent).toBe('chargerSearch.noResults');
  });

  it('shows the loading state while the search runs', async () => {
    getMock.mockImplementation((url: string) =>
      url.startsWith('/v1/portal/chargers/search')
        ? new Promise(() => undefined)
        : Promise.resolve({}),
    );
    renderList();
    search('CS');
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('shows an error with Retry when the search fails, and Retry searches again', async () => {
    let calls = 0;
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/v1/portal/chargers/search')) {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve([row]);
      }
      return Promise.resolve({});
    });
    renderList();
    search('CS');
    const error = await screen.findByTestId('error-state');
    expect(error.textContent).toContain('chargerSearch.searchError');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => {
      expect(screen.getByTestId('search-row')).toBeTruthy();
    });
  });
});
