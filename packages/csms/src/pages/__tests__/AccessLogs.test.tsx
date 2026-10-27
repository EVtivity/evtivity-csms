// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useLocation } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return { apiMock: { get: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});

import { AccessLogs } from '@/pages/AccessLogs';

let lastSearch = '';
function LocationProbe(): null {
  lastSearch = useLocation().search;
  return null;
}

function renderPage(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, '', url);
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AccessLogs />
        <LocationProbe />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function lastQueryFor(path: string): URLSearchParams {
  const calls = apiMock.get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(path));
  const url = calls[calls.length - 1] ?? '';
  return new URLSearchParams(url.split('?')[1] ?? '');
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.get.mockResolvedValue({ data: [], total: 0 });
});

afterEach(() => {
  cleanup();
});

describe('AccessLogs date range', () => {
  it('sends the day bounds of the URL range on the CSMS tab', async () => {
    renderPage('/logs?from=2026-10-01&to=2026-10-03');
    await waitFor(() => {
      expect(lastQueryFor('/v1/access-logs').get('from')).toBe(
        new Date('2026-10-01T00:00:00').toISOString(),
      );
    });
    expect(lastQueryFor('/v1/access-logs').get('to')).toBe(
      new Date('2026-10-03T23:59:59.999').toISOString(),
    );
    expect(lastQueryFor('/v1/access-logs').get('category')).toBe('csms');
  });

  it('keeps the range on the Workers tab', async () => {
    renderPage('/logs?tab=workers&from=2026-10-01');
    await waitFor(() => {
      expect(lastQueryFor('/v1/worker-logs').get('from')).toBe(
        new Date('2026-10-01T00:00:00').toISOString(),
      );
    });
    expect(lastQueryFor('/v1/worker-logs').get('to')).toBeNull();
  });

  it('writes a picked day to the URL and clears both', async () => {
    renderPage('/logs?tab=api');
    await waitFor(() => {
      expect(lastQueryFor('/v1/access-logs').get('category')).toBe('api');
    });
    fireEvent.change(screen.getAllByLabelText('common.to')[0] as HTMLElement, {
      target: { value: '2026-10-09' },
    });
    await waitFor(() => {
      expect(new URLSearchParams(lastSearch).get('to')).toBe('2026-10-09');
    });
    expect(new URLSearchParams(lastSearch).get('tab')).toBe('api');
    fireEvent.click(screen.getAllByText('common.clearDates')[0] as HTMLElement);
    await waitFor(() => {
      expect(new URLSearchParams(lastSearch).get('to')).toBeNull();
    });
  });

  it('ignores a day in the URL that is not a date', async () => {
    renderPage('/logs?from=yesterday');
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(lastQueryFor('/v1/access-logs').get('from')).toBeNull();
  });
});
