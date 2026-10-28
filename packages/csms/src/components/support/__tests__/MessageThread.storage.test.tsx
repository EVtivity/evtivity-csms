// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => true,
  useHasAllSiteAccess: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock }, postStream: vi.fn() };
});

import { ApiError } from '@/lib/api';
import { MessageThread } from '../MessageThread';

function renderThread(s3Configured: boolean | undefined, onMessageSent = vi.fn()): void {
  getMock.mockResolvedValue({ enabled: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MessageThread
          caseId="case-1"
          messages={[]}
          timezone="UTC"
          s3Configured={s3Configured}
          supportAiEnabled={false}
          onMessageSent={onMessageSent}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('MessageThread attachments without file storage', () => {
  it('keeps the attach button enabled and opens the storage dialog instead of the file chooser', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    renderThread(false);
    const attach = screen.getByTestId('support-attach');
    expect((attach as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(attach);
    expect(screen.getByRole('dialog', { name: 'storageUnavailable.title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'storageUnavailable.openSettings' })).toBeTruthy();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('opens the file chooser while file storage is set up', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    renderThread(true);
    fireEvent.click(screen.getByTestId('support-attach'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the storage dialog when an upload answers STORAGE_NOT_CONFIGURED', async () => {
    postMock.mockImplementation((path: string) =>
      path === '/v1/support-cases/case-1/messages'
        ? Promise.resolve({ id: 7 })
        : Promise.reject(
            new ApiError(400, { error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' }),
          ),
    );
    const onMessageSent = vi.fn();
    renderThread(true, onMessageSent);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'log.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'See the log' } });
    fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement);
    expect(await screen.findByRole('dialog', { name: 'storageUnavailable.title' })).toBeTruthy();
    // The message itself was sent: the thread refreshes and shows no send error.
    await waitFor(() => {
      expect(onMessageSent).toHaveBeenCalled();
    });
    expect(screen.queryByText('supportCases.sendFailed')).toBeNull();
  });
});
