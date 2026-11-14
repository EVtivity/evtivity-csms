// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The support cases list is opened from Home and Account, and its back returns
// to where it was opened from, also after the driver viewed several cases. A
// case and the new case form go back to the list entry they came from instead
// of pushing a second list on top of themselves.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: vi.fn() }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/timezone', () => ({ useDriverTimezone: () => 'UTC' }));

import { SupportCases } from '../SupportCases';
import { SupportCaseDetail } from '../SupportCaseDetail';

function supportCase(id: string) {
  return {
    id,
    caseNumber: `SC-${id}`,
    subject: `Subject ${id}`,
    description: 'It stopped',
    status: 'open',
    category: 'charging_failure',
    priority: 'medium',
    sessions: [],
    stationName: null,
    resolvedAt: null,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    messages: [],
    ai: null,
  };
}

getMock.mockImplementation((path: string) => {
  if (path.startsWith('/v1/portal/support-cases?')) {
    return Promise.resolve({ data: [supportCase('c1'), supportCase('c2')], total: 2 });
  }
  const id = path.split('/').pop() ?? '';
  return Promise.resolve(supportCase(id));
});

afterEach(() => {
  cleanup();
});

function Start({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <div>
      <h1>{name}</h1>
      <Link to="/support">open support</Link>
      <button
        type="button"
        onClick={() => {
          void navigate('/account');
        }}
      >
        go account
      </button>
    </div>
  );
}

function renderAt(path: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Start name="home page" />} />
          <Route path="/account" element={<Start name="account page" />} />
          <Route path="/support" element={<SupportCases />} />
          <Route path="/support/:id" element={<SupportCaseDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openCase(id: string): Promise<void> {
  fireEvent.click(await screen.findByText(`Subject ${id}`));
  await screen.findByText(`SC-${id}`);
}

async function back(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'common.back' }));
}

async function onList(): Promise<void> {
  expect(await screen.findByRole('heading', { name: 'supportCases.title' })).toBeTruthy();
}

describe('support navigation', () => {
  it('goes Home, the list, a case, back, back to Home', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('open support'));
    await openCase('c1');
    await back();
    await onList();
    await back();
    expect(await screen.findByText('home page')).toBeTruthy();
  });

  it('goes Account, the list, a case, back, back to Account', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('go account'));
    fireEvent.click(await screen.findByText('open support'));
    await openCase('c1');
    await back();
    await onList();
    await back();
    expect(await screen.findByText('account page')).toBeTruthy();
  });

  it('keeps the list back on Home after several cases', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('open support'));
    for (const id of ['c1', 'c2', 'c1']) {
      await openCase(id);
      await back();
      await onList();
    }
    await back();
    expect(await screen.findByText('home page')).toBeTruthy();
  });

  it('opens a case from a link, then goes back to the list and Home', async () => {
    renderAt('/support/c9');
    await screen.findByText('SC-c9');
    await back();
    await onList();
    // The list replaced the case as the first page: its back goes Home.
    await back();
    expect(await screen.findByText('home page')).toBeTruthy();
  });

  it('lists each case as a link Tab reaches, to the case page', async () => {
    renderAt('/support');
    const rows = await screen.findAllByTestId('support-case-row');
    expect(rows.map((r) => r.tagName)).toEqual(['A', 'A']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/support/c1', '/support/c2']);
  });
});
