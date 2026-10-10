// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { formatAiStreamEvent } from '@evtivity/lib/ai-stream';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';

const { apiMock, postStreamMock, permissions } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  postStreamMock: vi.fn(),
  permissions: { write: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: '',
  PORTAL_BASE_URL: 'https://portal.example.com',
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => (perm.endsWith(':write') ? permissions.write : true),
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock, postStream: postStreamMock };
});

import { ApiError } from '@/lib/api';
import { AiPanel } from '../AiPanel';

const NONCE = 'nonce-'.padEnd(32, 'x');

/** A body that sends `events` and then stays open until aborted (when `hold`). */
function sseBody(
  events: AiStreamEvent[],
  signal: AbortSignal,
  hold = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(formatAiStreamEvent(e)));
      if (!hold) {
        controller.close();
        return;
      }
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
}

const start = (messageId: string): AiStreamEvent => ({
  type: 'message_start',
  protocolVersion: 1,
  conversationId: 'conv1',
  messageId,
  provider: 'deepseek',
  model: 'deepseek-v4',
});

function renderPanel(onClose = vi.fn()): { onClose: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/stations']}>
        <AiPanel onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

function type(text: string): void {
  fireEvent.change(screen.getByLabelText('ai.inputLabel'), { target: { value: text } });
}

beforeEach(() => {
  permissions.write = true;
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.post.mockImplementation((path: string) =>
    path === '/v1/assistant/conversations'
      ? Promise.resolve({
          id: 'conv1',
          title: '',
          provider: '',
          model: '',
          createdAt: '',
          updatedAt: '',
        })
      : Promise.reject(new Error(`unexpected ${path}`)),
  );
  apiMock.get.mockResolvedValue({ data: [], total: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiPanel', () => {
  it('shows the suggested prompts of the current page when empty (TC-AI-UI-06)', () => {
    renderPanel();
    expect(screen.getByTestId('ai-suggestions').getAttribute('data-page')).toBe('stations');
    expect(screen.getByText('ai.suggestions.stations.p1')).toBeTruthy();
  });

  it('TC-AI-UI-01: streams the answer and Stop aborts it', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody([start('m1'), { type: 'text_delta', text: 'Checking the station' }], signal, true),
      ),
    );
    renderPanel();
    type('Why is CS-1 faulted?');
    fireEvent.keyDown(screen.getByLabelText('ai.inputLabel'), { key: 'Enter' });

    expect(await screen.findByText('Checking the station')).toBeTruthy();
    expect(postStreamMock).toHaveBeenCalledWith(
      '/v1/assistant/conversations/conv1/messages',
      { text: 'Why is CS-1 faulted?' },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('true');

    fireEvent.click(screen.getByTestId('ai-stop'));
    expect(await screen.findByText('ai.stopped')).toBeTruthy();
    expect(screen.queryByTestId('ai-stop')).toBeNull();
  });

  it('Esc stops a running stream first, then closes the panel (TC-AI-UI-07)', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(sseBody([start('m1')], signal, true)),
    );
    const { onClose } = renderPanel();
    type('hello');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    await screen.findByTestId('ai-stop');
    const panel = screen.getByTestId('ai-panel');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await screen.findByText('ai.stopped');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter does not send and Up recalls the last message (TC-AI-UI-07)', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody([start('m1'), { type: 'done', messageId: 'm1', finish: 'end' }], signal),
      ),
    );
    renderPanel();
    const input = screen.getByLabelText<HTMLTextAreaElement>('ai.inputLabel');
    type('first question');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(postStreamMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(postStreamMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('first question');
  });

  it('TC-AI-UI-02: tool steps are collapsed and expand on click', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody(
          [
            start('m1'),
            {
              type: 'tool_step',
              toolCallId: 't1',
              name: 'get_station',
              status: 'ok',
              durationMs: 12,
              summary: 'CS-1',
            },
            { type: 'text_delta', text: 'Done.' },
            { type: 'done', messageId: 'm1', finish: 'end' },
          ],
          signal,
        ),
      ),
    );
    renderPanel();
    type('status?');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    const toggle = await screen.findByRole('button', { name: /ai.toolSteps/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('get_station')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('get_station')).toBeTruthy();
    expect(screen.getByText('ai.stepStatus.ok')).toBeTruthy();
  });

  it('TC-AI-UI-03: the confirm card sends the nonce and nothing runs before it', async () => {
    postStreamMock.mockImplementation((path: string, _b: unknown, signal: AbortSignal) => {
      if (path.endsWith('/messages')) {
        return Promise.resolve(
          sseBody(
            [
              start('m1'),
              {
                type: 'confirmation_required',
                actionId: 'act1',
                toolCallId: 't1',
                name: 'update_station',
                nonce: NONCE,
                method: 'POST',
                path: '/v1/stations/CS-1/reset',
                summary: 'Reset CS-1',
                arguments: { type: 'Soft' },
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
              { type: 'done', messageId: 'm1', finish: 'confirmation_required' },
            ],
            signal,
          ),
        );
      }
      return Promise.resolve(
        sseBody(
          [
            start('m2'),
            { type: 'text_delta', text: 'Reset sent.' },
            { type: 'done', messageId: 'm2', finish: 'end' },
          ],
          signal,
        ),
      );
    });
    renderPanel();
    type('reset CS-1');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    const card = await screen.findByTestId('ai-confirm-card');
    expect(card.textContent).toContain('/v1/stations/CS-1/reset');
    expect(postStreamMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'ai.confirm' }));
    expect(await screen.findByText('Reset sent.')).toBeTruthy();
    expect(postStreamMock).toHaveBeenLastCalledWith(
      '/v1/assistant/conversations/conv1/actions/act1/confirm',
      { nonce: NONCE },
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('ai.confirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ai.confirm' })).toBeNull();
  });

  it('reject posts to the reject endpoint', async () => {
    postStreamMock.mockImplementation((path: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody(
          path.endsWith('/messages')
            ? [
                start('m1'),
                {
                  type: 'confirmation_required',
                  actionId: 'act9',
                  toolCallId: 't1',
                  name: 'update_station',
                  nonce: NONCE,
                  method: 'DELETE',
                  path: '/v1/tokens/7',
                  summary: 'Delete token 7',
                  arguments: {},
                  expiresAt: new Date(Date.now() + 300_000).toISOString(),
                },
                { type: 'done', messageId: 'm1', finish: 'confirmation_required' },
              ]
            : [start('m2'), { type: 'done', messageId: 'm2', finish: 'end' }],
          signal,
        ),
      ),
    );
    renderPanel();
    type('delete token 7');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ai.reject' }));
    await screen.findByText('ai.rejected');
    expect(postStreamMock).toHaveBeenLastCalledWith(
      '/v1/assistant/conversations/conv1/actions/act9/reject',
      { nonce: NONCE },
      expect.any(AbortSignal),
    );
  });

  it('shows a refused request by its translated error code', async () => {
    postStreamMock.mockRejectedValue(new ApiError(429, { code: 'AI_RATE_LIMITED', error: 'x' }));
    renderPanel();
    type('hi');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    expect(await screen.findByText('ai.errors.generic')).toBeTruthy();
  });

  it('a stream error event shows its code, never the server text', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody(
          [
            start('m1'),
            { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'upstream said something' },
            { type: 'done', messageId: 'm1', finish: 'error' },
          ],
          signal,
        ),
      ),
    );
    renderPanel();
    type('hi');
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/upstream said something/)).toBeNull();
  });

  it('without aiAssistant:write there is no composer and no suggestions', () => {
    permissions.write = false;
    renderPanel();
    expect(screen.queryByLabelText('ai.inputLabel')).toBeNull();
    expect(screen.queryByTestId('ai-suggestions')).toBeNull();
    expect(screen.getByText('ai.readOnly')).toBeTruthy();
  });

  it('TC-AI-UI-04: dropped files upload, show previews and per-file errors, and send their ids', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    apiMock.post.mockImplementation((path: string) => {
      if (path === '/v1/assistant/conversations') return Promise.resolve({ id: 'conv1' });
      if (path === '/v1/assistant/attachments/upload-url') {
        return Promise.resolve({
          attachmentId: 'att1',
          uploadUrl: 'https://s3.example.com/b',
          fields: { key: 'k' },
          expiresAt: '2030-01-01T00:00:00Z',
        });
      }
      if (path === '/v1/assistant/attachments/att1/confirm') {
        return Promise.resolve({
          id: 'att1',
          fileName: 'screen.png',
          contentType: 'image/png',
          kind: 'image',
          sizeBytes: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        sseBody([start('m1'), { type: 'done', messageId: 'm1', finish: 'end' }], signal),
      ),
    );
    renderPanel();
    const panel = screen.getByTestId('ai-panel');
    const good = new File(['x'], 'screen.png', { type: 'image/png' });
    const bad = new File(['<html>'], 'page.html', { type: 'text/html' });
    act(() => {
      fireEvent.drop(panel, { dataTransfer: { files: [good, bad], types: ['Files'] } });
    });
    expect(await screen.findByAltText('screen.png')).toBeTruthy();
    expect(screen.getByText('ai.attachmentErrors.typeNotAllowed')).toBeTruthy();
    const removeButtons = await screen.findAllByRole('button', { name: 'ai.removeAttachment' });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText('page.html')).toBeNull();
    });

    type('What does this screen say?');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ai.send' }).hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
    await waitFor(() => {
      expect(postStreamMock).toHaveBeenCalledWith(
        '/v1/assistant/conversations/conv1/messages',
        { text: 'What does this screen say?', attachmentIds: ['att1'] },
        expect.any(AbortSignal),
      );
    });
    vi.unstubAllGlobals();
  });

  it('a file the server refuses shows its error code', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    apiMock.post.mockRejectedValue(new ApiError(400, { code: 'AI_ATTACHMENT_REJECTED' }));
    renderPanel();
    const file = new File(['x'], 'fake.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('ai.inputLabel'), { clipboardData: { files: [file] } });
    expect(await screen.findByText('errors.AI_ATTACHMENT_REJECTED')).toBeTruthy();
  });

  it('TC-AI-UI-04: a pasted image is queued as an attachment', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    renderPanel();
    const file = new File(['x'], 'paste.jpg', { type: 'image/jpeg' });
    fireEvent.paste(screen.getByLabelText('ai.inputLabel'), { clipboardData: { files: [file] } });
    expect(await screen.findByAltText('paste.jpg')).toBeTruthy();
  });

  it('opens a conversation from the history', async () => {
    apiMock.get.mockImplementation((path: string) =>
      path.startsWith('/v1/assistant/conversations?')
        ? Promise.resolve({
            data: [
              {
                id: 'old1',
                title: 'Fault on CS-1',
                provider: 'deepseek',
                model: 'm',
                createdAt: '2026-10-01T00:00:00Z',
                updatedAt: '2026-10-01T00:00:00Z',
              },
            ],
            total: 1,
          })
        : Promise.resolve({
            id: 'old1',
            title: 'Fault on CS-1',
            messages: [
              {
                id: 'u1',
                role: 'user',
                parts: [{ type: 'text', text: 'What happened?' }],
                finishReason: null,
              },
              {
                id: 'a1',
                role: 'assistant',
                parts: [{ type: 'text', text: 'A ground fault.' }],
                finishReason: 'end',
              },
            ],
          }),
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'ai.history' }));
    fireEvent.click(await screen.findByText('Fault on CS-1'));
    expect(await screen.findByText('A ground fault.')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/assistant/conversations/old1');
  });
});
