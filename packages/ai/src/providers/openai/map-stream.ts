// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import type { AiFinishReason, AiStreamEvent } from '../../core/types.js';
import { toolCallCut, toolCallEnd, usage } from '../shared.js';
import type { OpenAiOpaqueState } from './map-request.js';

interface ToolCall {
  callId: string;
  name: string;
  args: string;
  open: boolean;
}

/** A failure the Responses stream reported (`error` or `response.failed`). */
export class OpenAiStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'OpenAiStreamError';
  }
}

/**
 * Turns Responses API stream events into neutral events and keeps the
 * turn's output items, so encrypted reasoning can be sent back in the next
 * tool round (`store: false`).
 */
export class OpenAiStreamMapper {
  private readonly calls = new Map<string, ToolCall>();
  private readonly items: ResponseInputItem[] = [];
  private toolCount = 0;
  private hasReasoning = false;
  private refused = false;
  private incomplete: AiFinishReason | null = null;
  private completed = false;

  constructor(private readonly model: string) {}

  handle(event: ResponseStreamEvent): AiStreamEvent[] {
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item;
        if (item.type !== 'function_call') return [];
        const call: ToolCall = { callId: item.call_id, name: item.name, args: '', open: true };
        this.calls.set(item.id ?? item.call_id, call);
        return [
          { type: 'tool_call_start', index: this.toolCount++, id: call.callId, name: call.name },
        ];
      }
      case 'response.function_call_arguments.delta': {
        const call = this.calls.get(event.item_id);
        if (call === undefined || event.delta === '') return [];
        call.args += event.delta;
        return [{ type: 'tool_call_delta', id: call.callId, argumentsDelta: event.delta }];
      }
      case 'response.output_item.done': {
        const item = event.item;
        this.items.push(item as ResponseInputItem);
        if (item.type === 'reasoning') this.hasReasoning = true;
        if (item.type !== 'function_call') return [];
        const call = this.calls.get(item.id ?? item.call_id);
        if (call === undefined || !call.open) return [];
        call.open = false;
        return [toolCallEnd(call.callId, call.name, item.arguments)];
      }
      case 'response.output_text.delta':
        return event.delta === '' ? [] : [{ type: 'text_delta', text: event.delta }];
      case 'response.refusal.delta':
        this.refused = true;
        return event.delta === '' ? [] : [{ type: 'text_delta', text: event.delta }];
      case 'response.completed':
        this.completed = true;
        return this.usageEvents(event.response.usage);
      case 'response.incomplete': {
        const reason = event.response.incomplete_details?.reason;
        this.incomplete = reason === 'content_filter' ? 'refusal' : 'max_tokens';
        return this.usageEvents(event.response.usage);
      }
      case 'response.failed': {
        const error = event.response.error;
        throw new OpenAiStreamError(
          error?.code ?? 'server_error',
          error?.message ?? 'The response failed',
        );
      }
      case 'error':
        throw new OpenAiStreamError(event.code ?? 'error', event.message);
      default:
        return [];
    }
  }

  private usageEvents(u: ResponseUsage | null | undefined): AiStreamEvent[] {
    if (u === null || u === undefined) return [];
    return [
      {
        type: 'usage',
        usage: usage({
          inputTokens: u.input_tokens,
          cachedReadTokens: u.input_tokens_details.cached_tokens,
          cacheWriteTokens: u.input_tokens_details.cache_write_tokens,
          outputTokens: u.output_tokens,
          reasoningTokens: u.output_tokens_details.reasoning_tokens,
        }),
      },
    ];
  }

  end(aborted: boolean): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    for (const call of this.calls.values()) {
      if (call.open) {
        call.open = false;
        out.push(toolCallCut(call.callId, call.name, call.args));
      }
    }
    if (aborted) {
      out.push({ type: 'finish', reason: 'stopped' });
      return out;
    }
    if (!this.completed && this.incomplete === null) {
      throw new OpenAiStreamError('stream_truncated', 'The response stream ended early');
    }
    let reason: AiFinishReason;
    if (this.incomplete !== null) reason = this.incomplete;
    else if (this.refused) reason = 'refusal';
    else if (this.calls.size > 0) reason = 'tool_use';
    else reason = 'end';
    if (!this.hasReasoning) {
      out.push({ type: 'finish', reason });
      return out;
    }
    const opaque: OpenAiOpaqueState = { items: this.items };
    out.push({
      type: 'finish',
      reason,
      providerState: { provider: 'openai', model: this.model, opaque },
    });
    return out;
  }
}
