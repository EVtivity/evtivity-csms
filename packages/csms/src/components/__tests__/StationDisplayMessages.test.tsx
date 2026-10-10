// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, deleteMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  deleteMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, delete: deleteMock, post: postMock }, ApiError };
});

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/timezone', () => ({ formatDateTime: (value: string) => value }));

import { ApiError } from '@/lib/api';
import { StationDisplayMessages } from '../StationDisplayMessages';

const MESSAGE = {
  id: 7,
  stationId: 'sta_1',
  ocppMessageId: 3,
  priority: 'NormalCycle',
  status: 'accepted',
  state: null,
  format: 'UTF8',
  language: null,
  content: 'Welcome',
  startDateTime: null,
  endDateTime: null,
  transactionId: null,
  evseId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
};

function renderMessages(isOnline: boolean): void {
  getMock.mockResolvedValue({ data: [MESSAGE], total: 1 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationDisplayMessages stationId="sta_1" isOnline={isOnline} timezone="UTC" />
    </QueryClientProvider>,
  );
}

async function clearMessage(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'stations.clearMessage' }));
  const dialog = screen.getByRole('dialog', { name: 'stations.clearMessage' });
  const confirm = Array.from(dialog.querySelectorAll('button')).find(
    (b) => b.textContent === 'stations.clearMessage',
  );
  if (confirm == null) throw new Error('confirm button not found');
  fireEvent.click(confirm);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationDisplayMessages', () => {
  it('queues a clear for an offline station and says so', async () => {
    deleteMock.mockResolvedValue({ status: 'queued', code: 'COMMAND_QUEUED' });
    renderMessages(false);

    await clearMessage();

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/stations/sta_1/display-messages/7');
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'stations.messageCommandQueued',
        variant: 'warning',
      });
    });
  });

  it('shows no queued notice when the station cleared the message', async () => {
    deleteMock.mockResolvedValue({ status: 'cleared' });
    renderMessages(true);

    await clearMessage();

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalled();
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('shows the translated error when the clear fails', async () => {
    deleteMock.mockRejectedValue(
      new ApiError(502, { error: 'Connection lost', code: 'MESSAGE_CLEAR_FAILED' }),
    );
    renderMessages(true);

    await clearMessage();

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Connection lost',
        variant: 'destructive',
      });
    });
  });
});
