// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatAiStreamEvent } from '@evtivity/lib/ai-stream';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';

const { getMock, postStreamMock, status } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postStreamMock: vi.fn(),
  status: { support: true, read: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => (perm === 'aiAssistant:read' ? status.read : true),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() }, postStream: postStreamMock };
});

import { ApiError } from '@/lib/api';
import { MessageThread } from '../MessageThread';

function body(
  events: AiStreamEvent[],
  signal: AbortSignal,
  hold = false,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(formatAiStreamEvent(e)));
      if (!hold) {
        controller.close();
        return;
      }
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('aborted', 'AbortError'));
      });
    },
  });
}

function renderThread(supportAiEnabled = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageThread
        caseId="case-1"
        messages={[]}
        timezone="UTC"
        s3Configured
        supportAiEnabled={supportAiEnabled}
        onMessageSent={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  status.support = true;
  status.read = true;
  Element.prototype.scrollIntoView = vi.fn();
  getMock.mockImplementation((path: string) =>
    path === '/v1/assistant/status'
      ? Promise.resolve({ enabled: true, supportAssistEnabled: status.support })
      : Promise.reject(new Error(path)),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MessageThread support AI assist', () => {
  it('TC-AI-UI-11: streams the draft into the message box and shows the sources', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(
        body(
          [
            {
              type: 'message_start',
              protocolVersion: 1,
              conversationId: 'c',
              messageId: 'm',
              provider: 'deepseek',
              model: 'x',
            },
            { type: 'tool_step', toolCallId: 't1', name: 'get_support_case', status: 'ok' },
            { type: 'text_delta', text: 'Hello, ' },
            { type: 'text_delta', text: 'we reset the station.' },
            { type: 'done', messageId: 'm', finish: 'end' },
          ],
          signal,
        ),
      ),
    );
    renderThread();
    fireEvent.click(await screen.findByRole('button', { name: /supportCases.aiAssist$/ }));
    const box = screen.getByLabelText<HTMLTextAreaElement>('supportCases.messagePlaceholder');
    await waitFor(() => {
      expect(box.value).toBe('Hello, we reset the station.');
    });
    expect(postStreamMock).toHaveBeenCalledWith(
      '/v1/support-cases/case-1/ai-assist',
      { isInternalNote: false },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('button', { name: /ai.sources/ })).toBeTruthy();
  });

  it('Stop ends the draft and keeps the text so far', async () => {
    postStreamMock.mockImplementation((_p: string, _b: unknown, signal: AbortSignal) =>
      Promise.resolve(body([{ type: 'text_delta', text: 'Partial draft' }], signal, true)),
    );
    renderThread();
    fireEvent.click(await screen.findByRole('button', { name: /supportCases.aiAssist$/ }));
    fireEvent.click(await screen.findByTestId('support-ai-stop'));
    await waitFor(() => {
      expect(screen.queryByTestId('support-ai-stop')).toBeNull();
    });
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('supportCases.messagePlaceholder').value,
    ).toBe('Partial draft');
  });

  it('shows a refused draft by its error code', async () => {
    postStreamMock.mockRejectedValue(new ApiError(429, { code: 'AI_RATE_LIMITED' }));
    renderThread();
    fireEvent.click(await screen.findByRole('button', { name: /supportCases.aiAssist$/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('hides the button when supportAi.enabled is false', async () => {
    renderThread(false);
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /supportCases.aiAssist$/ })).toBeNull();
  });

  it('hides the button when the status says support AI cannot run (no provider key)', async () => {
    status.support = false;
    renderThread();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /supportCases.aiAssist$/ })).toBeNull();
  });

  it('hides the button without aiAssistant:read', () => {
    status.read = false;
    renderThread();
    expect(screen.queryByRole('button', { name: /supportCases.aiAssist$/ })).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});
