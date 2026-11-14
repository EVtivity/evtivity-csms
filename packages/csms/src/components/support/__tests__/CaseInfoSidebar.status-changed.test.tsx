// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A status change the API refuses because the driver closed or reopened the
// case meanwhile (409 SUPPORT_CASE_CHANGED) shows the reason and reloads the case.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

const CHANGED_TEXT = 'The case status changed since you opened it.';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'errors.SUPPORT_CASE_CHANGED' ? CHANGED_TEXT : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), patch: patchMock, delete: vi.fn() } };
});

import { ApiError } from '@/lib/api';
import { CaseInfoSidebar } from '../CaseInfoSidebar';

const CASE = {
  id: 'cas_1',
  status: 'open',
  priority: 'medium',
  category: 'general_inquiry',
  assignedTo: null,
  messages: [],
};

afterEach(() => {
  cleanup();
  patchMock.mockReset();
});

describe('CaseInfoSidebar status change refused', () => {
  it('shows the translated reason and reloads the case', async () => {
    patchMock.mockRejectedValue(
      new ApiError(409, { error: 'changed', code: 'SUPPORT_CASE_CHANGED' }),
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <CaseInfoSidebar caseDetail={CASE} operatorUsers={[]} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('common.status'), {
      target: { value: 'in_progress' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByText(CHANGED_TEXT)).toBeTruthy();
    });
    expect(patchMock).toHaveBeenCalledWith('/v1/support-cases/cas_1', { status: 'in_progress' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['support-cases', 'cas_1'] });
  });
});
