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
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));

import { Audit } from '@/pages/Audit';

const ROW = {
  id: 7,
  entityType: 'site',
  entityId: 'sit_1',
  entityIdSnapshot: 'sit_1',
  action: 'updated',
  actor: 'operator',
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
  actorName: 'Ada Admin',
  before: { name: 'Old', city: 'Berlin' },
  after: { name: 'New', city: 'Berlin' },
  notes: null,
  viaAi: null,
  createdAt: '2026-10-14T10:00:00.000Z',
};

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
        <Audit />
        <LocationProbe />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function lastQuery(): URLSearchParams {
  const calls = apiMock.get.mock.calls;
  const url = String(calls[calls.length - 1]?.[0] ?? '');
  return new URLSearchParams(url.split('?')[1] ?? '');
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.get.mockResolvedValue({ data: [ROW], total: 1 });
});

afterEach(() => {
  cleanup();
});

describe('Audit page', () => {
  it('reads every filter from the URL and sends the day bounds', async () => {
    renderPage(
      '/audit?entityType=site&actor=operator&action=updated&from=2026-10-01&to=2026-10-02',
    );
    await screen.findByTestId('audit-row-site-7');
    const q = lastQuery();
    expect(q.get('entityType')).toBe('site');
    expect(q.get('actor')).toBe('operator');
    expect(q.get('action')).toBe('updated');
    expect(q.get('from')).toBe(new Date('2026-10-01T00:00:00').toISOString());
    expect(q.get('to')).toBe(new Date('2026-10-02T23:59:59.999').toISOString());
  });

  it('writes a picked day to the URL', async () => {
    renderPage('/audit');
    await screen.findByTestId('audit-row-site-7');
    fireEvent.change(screen.getAllByLabelText('common.from')[0] as HTMLElement, {
      target: { value: '2026-10-05' },
    });
    await waitFor(() => {
      expect(new URLSearchParams(lastSearch).get('from')).toBe('2026-10-05');
    });
    await waitFor(() => {
      expect(lastQuery().get('from')).toBe(new Date('2026-10-05T00:00:00').toISOString());
    });
  });

  it('opens the entry with its changes on a row click', async () => {
    renderPage('/audit');
    const row = await screen.findByTestId('audit-row-site-7');
    fireEvent.click(row.querySelector('[data-testid="row-click-target"]') as HTMLElement);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('audit-field-name')).toBeTruthy();
    expect(screen.queryByTestId('audit-field-city')).toBeNull();
  });
});
