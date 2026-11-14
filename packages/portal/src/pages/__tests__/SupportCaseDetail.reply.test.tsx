// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The support case reply box: the message field and the Send button share the
// 48 px field height on one line, the field grows with its text, and the
// button stays on the field's bottom edge at its size.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: postMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/timezone', () => ({ useDriverTimezone: () => 'UTC' }));

import { SupportCaseDetail } from '../SupportCaseDetail';

function supportCase(extra: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    caseNumber: 'SC-0001',
    subject: 'Charging stopped',
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
    ...extra,
  };
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/support/case-1']}>
        <Routes>
          <Route path="/support/:id" element={<SupportCaseDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/);
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('support case reply box', () => {
  it('gives the field and the Send button one height and aligns them at the bottom', async () => {
    getMock.mockResolvedValue(supportCase());
    renderPage();
    const field = await screen.findByLabelText('supportCases.messagePlaceholder');
    const send = screen.getByRole('button', { name: 'supportCases.sendMessage' });
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.getAttribute('rows')).toBe('1');
    // One line is 48 px (min-h-12) and grows with the text up to max-h-36.
    expect(classes(field)).toEqual(
      expect.arrayContaining(['min-h-12', 'max-h-36', 'field-sizing-content', 'resize-none']),
    );
    // The Send button has the field height and keeps it as the field grows.
    expect(classes(send)).toEqual(expect.arrayContaining(['h-12', 'shrink-0']));
    expect(classes(field.closest('form') as HTMLElement)).toContain('items-end');
  });

  it('closes the case after the driver confirms', async () => {
    getMock.mockResolvedValue(supportCase());
    postMock.mockResolvedValue({ id: 'case-1', status: 'resolved', resolutionSource: 'driver' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.closeCase' }));
    expect(screen.getByText('supportCases.closeConfirmTitle')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'supportCases.closeCase' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/support-cases/case-1/close', {});
    });
  });

  it.each(['resolved', 'closed'])(
    'keeps the message box on a %s case, says a message reopens it, and offers no close',
    async (status) => {
      getMock.mockResolvedValue(supportCase({ status }));
      renderPage();
      expect(await screen.findByText('supportCases.reopenNote')).toBeTruthy();
      expect(screen.getByLabelText('supportCases.messagePlaceholder')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'supportCases.closeCase' })).toBeNull();
    },
  );

  it('shows no reopen note on an open case', async () => {
    getMock.mockResolvedValue(supportCase());
    renderPage();
    await screen.findByLabelText('supportCases.messagePlaceholder');
    expect(screen.queryByText('supportCases.reopenNote')).toBeNull();
  });

  it('sends on Enter and starts a new line on Shift+Enter', async () => {
    getMock.mockResolvedValue(supportCase());
    postMock.mockResolvedValue({ id: 9 });
    renderPage();
    const field = await screen.findByLabelText('supportCases.messagePlaceholder');
    fireEvent.change(field, { target: { value: 'Still not working' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/support-cases/case-1/messages', {
        body: 'Still not working',
      });
    });
  });

  it('posts once for a quick double Enter while the send is pending', async () => {
    getMock.mockResolvedValue(supportCase());
    let resolvePost: (value: unknown) => void = () => undefined;
    postMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    renderPage();
    const field = await screen.findByLabelText('supportCases.messagePlaceholder');
    fireEvent.change(field, { target: { value: 'Still not working' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(postMock).toHaveBeenCalledTimes(1);
    resolvePost({ id: 9 });
  });
});
