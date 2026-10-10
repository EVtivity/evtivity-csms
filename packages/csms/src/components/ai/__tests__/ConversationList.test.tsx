// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));

import { ConversationList } from '../ConversationList';

const ITEM = {
  id: 'c1',
  title: 'Faulted stations',
  provider: 'deepseek',
  model: 'deepseek-v4',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
};

function renderList(props: Partial<React.ComponentProps<typeof ConversationList>> = {}) {
  const handlers = { onOpen: vi.fn(), onNew: vi.fn(), onDeleted: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConversationList activeId={null} canWrite {...handlers} {...props} />
    </QueryClientProvider>,
  );
  return handlers;
}

beforeEach(() => {
  apiMock.get.mockResolvedValue({ data: [ITEM], total: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConversationList (TC-AI-UI-05)', () => {
  it('lists conversations and opens one', async () => {
    const { onOpen } = renderList();
    fireEvent.click(await screen.findByText('Faulted stations'));
    expect(onOpen).toHaveBeenCalledWith('c1');
  });

  it('renames a conversation', async () => {
    apiMock.patch.mockResolvedValue({ ...ITEM, title: 'CS-1 fault' });
    renderList();
    await screen.findByText('Faulted stations');
    fireEvent.click(screen.getByRole('button', { name: 'ai.renameConversation' }));
    const input = screen.getByLabelText('ai.renameLabel');
    fireEvent.change(input, { target: { value: 'CS-1 fault' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/assistant/conversations/c1', {
        title: 'CS-1 fault',
      });
    });
  });

  it('deletes a conversation after confirmation', async () => {
    apiMock.delete.mockResolvedValue({ success: true });
    const { onDeleted } = renderList({ activeId: 'c1' });
    await screen.findByText('Faulted stations');
    fireEvent.click(screen.getByRole('button', { name: 'ai.deleteConversation' }));
    expect(screen.getByText('ai.deleteTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/assistant/conversations/c1');
    });
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith('c1');
    });
  });

  it('hides rename, delete and new chat without write access', async () => {
    renderList({ canWrite: false });
    await screen.findByText('Faulted stations');
    expect(screen.queryByRole('button', { name: 'ai.renameConversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ai.deleteConversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: /ai.newChat/ })).toBeNull();
  });

  it('shows the empty state', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    renderList();
    expect(await screen.findByText('ai.noConversations')).toBeTruthy();
  });
});
