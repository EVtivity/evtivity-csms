// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  AiStreamEvent,
  AiStreamEventOf,
  AiStreamUsage,
  AiToolRefusalReason,
  AiToolStepStatus,
  AiTurnFinishReason,
} from '@evtivity/lib/ai-stream';

export interface AiToolStepView {
  toolCallId: string;
  name: string;
  status: AiToolStepStatus;
  summary?: string;
  /** Why the server refused the call (a refused step). */
  reason?: AiToolRefusalReason;
  durationMs?: number;
}

export type AiConfirmationState = 'pending' | 'confirming' | 'confirmed' | 'rejecting' | 'rejected';

export interface AiConfirmationView {
  event: AiStreamEventOf<'confirmation_required'>;
  state: AiConfirmationState;
}

export interface AiCitationView {
  id: string;
  title: string;
  url: string;
}

export interface AiAttachmentChip {
  id: string;
  name: string;
  kind: 'image' | 'document';
}

/** One message as the panel shows it. */
export interface AiMessageView {
  /** Stable React key: never changes once the view exists. */
  key: string;
  /** Server message id once known, else a local id. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: AiAttachmentChip[];
  toolSteps: AiToolStepView[];
  confirmation: AiConfirmationView | null;
  citations: AiCitationView[];
  usage: AiStreamUsage | null;
  /** API error code from an `error` event or a refused request. */
  errorCode: string | null;
  /** Safe display text that came with the error, if any. */
  errorMessage: string | null;
  /** Null while the answer is still streaming. */
  finish: AiTurnFinishReason | null;
  /**
   * True after a tool step that followed text: the model's next text is a new
   * paragraph, not a continuation of the sentence before the tools ran.
   */
  textBreak?: boolean;
}

let localIdCounter = 0;
export function localMessageId(): string {
  localIdCounter += 1;
  return `local-${String(localIdCounter)}`;
}

export function userMessage(text: string, attachments: AiAttachmentChip[] = []): AiMessageView {
  const id = localMessageId();
  return {
    key: id,
    id,
    role: 'user',
    text,
    attachments,
    toolSteps: [],
    confirmation: null,
    citations: [],
    usage: null,
    errorCode: null,
    errorMessage: null,
    finish: 'end',
  };
}

export function emptyAssistantMessage(): AiMessageView {
  const id = localMessageId();
  return {
    key: id,
    id,
    role: 'assistant',
    text: '',
    attachments: [],
    toolSteps: [],
    confirmation: null,
    citations: [],
    usage: null,
    errorCode: null,
    errorMessage: null,
    finish: null,
  };
}

/** Applies one stream event to the assistant message it belongs to. Pure. */
export function applyAiStreamEvent(msg: AiMessageView, event: AiStreamEvent): AiMessageView {
  switch (event.type) {
    case 'message_start':
      return { ...msg, id: event.messageId };
    case 'text_delta': {
      const separator =
        msg.textBreak === true && msg.text !== '' && !msg.text.endsWith('\n') ? '\n\n' : '';
      return { ...msg, text: msg.text + separator + event.text, textBreak: false };
    }
    case 'tool_step': {
      const step: AiToolStepView = {
        toolCallId: event.toolCallId,
        name: event.name,
        status: event.status,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      };
      const index = msg.toolSteps.findIndex((s) => s.toolCallId === event.toolCallId);
      const toolSteps =
        index === -1
          ? [...msg.toolSteps, step]
          : msg.toolSteps.map((s, i) => (i === index ? { ...s, ...step } : s));
      return { ...msg, toolSteps, textBreak: msg.text !== '' };
    }
    case 'confirmation_required':
      return { ...msg, confirmation: { event, state: 'pending' } };
    case 'citation': {
      if (msg.citations.some((c) => c.id === event.id)) return msg;
      return {
        ...msg,
        citations: [...msg.citations, { id: event.id, title: event.title, url: event.url }],
      };
    }
    case 'usage':
      return { ...msg, usage: event.usage };
    case 'error':
      return { ...msg, errorCode: event.code, errorMessage: event.message ?? null };
    case 'done':
      return { ...msg, id: event.messageId, finish: event.finish };
  }
}

/** Marks a message whose stream ended without a `done` event (stop or network loss). */
export function finishInterrupted(msg: AiMessageView, stopped: boolean): AiMessageView {
  if (msg.finish != null) return msg;
  const toolSteps = msg.toolSteps.map((s) =>
    s.status === 'running' ? { ...s, status: 'error' as const } : s,
  );
  return stopped
    ? { ...msg, toolSteps, finish: 'stopped' }
    : { ...msg, toolSteps, finish: 'error', errorCode: msg.errorCode ?? 'AI_ERROR' };
}

/** A stored message part (`GET /v1/assistant/conversations/:id`). */
export interface StoredAiPart {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  attachmentId?: unknown;
}

export interface StoredAiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  parts: StoredAiPart[];
  finishReason: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Rebuilds the panel view from stored messages. Tool results are folded into
 * the step of their call (ok or error); tool messages are not shown on their own.
 */
export function messagesFromHistory(stored: StoredAiMessage[]): AiMessageView[] {
  const out: AiMessageView[] = [];
  const stepOwner = new Map<string, AiMessageView>();
  for (const m of stored) {
    if (m.role === 'tool') {
      for (const part of m.parts) {
        if (part.type !== 'tool_result') continue;
        const owner = stepOwner.get(str(part.toolCallId));
        if (owner == null) continue;
        owner.toolSteps = owner.toolSteps.map((s) =>
          s.toolCallId === str(part.toolCallId)
            ? { ...s, status: part.isError === true ? 'error' : 'ok' }
            : s,
        );
      }
      continue;
    }
    const base = m.role === 'user' ? userMessage('') : emptyAssistantMessage();
    const view: AiMessageView = { ...base, key: m.id, id: m.id, finish: toFinish(m.finishReason) };
    for (const part of m.parts) {
      if (part.type === 'text') view.text += str(part.text);
      else if (part.type === 'image' || part.type === 'document') {
        view.attachments.push({
          id: str(part.attachmentId),
          name: str(part.name),
          kind: part.type,
        });
      } else if (part.type === 'tool_call') {
        view.toolSteps.push({ toolCallId: str(part.id), name: str(part.name), status: 'ok' });
        stepOwner.set(str(part.id), view);
      }
    }
    out.push(view);
  }
  return out;
}

const FINISH_REASONS: readonly string[] = [
  'end',
  'stopped',
  'max_tokens',
  'refusal',
  'context_exceeded',
  'confirmation_required',
  'error',
];

function toFinish(reason: string | null): AiTurnFinishReason {
  return reason != null && FINISH_REASONS.includes(reason) ? (reason as AiTurnFinishReason) : 'end';
}
