// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { AiFinishReason, AiStreamEvent } from '../../core/types.js';
import { toolCallCut, toolCallEnd, usage } from '../shared.js';
import type { DeepSeekOpaqueState } from './map-request.js';
import { parseDsmlInvokes, splitAtMarker } from './dsml.js';

interface ToolCall {
  id: string;
  name: string;
  args: string;
  open: boolean;
}

/** A failure DeepSeek reported inside the stream. */
export class DeepSeekStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DeepSeekStreamError';
  }
}

const FINISH_REASONS: Readonly<Record<string, AiFinishReason>> = {
  stop: 'end',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/** DeepSeek chunk fields the OpenAI types do not carry. */
interface DeepSeekDelta {
  reasoning_content?: string | null;
}
interface DeepSeekUsage {
  prompt_cache_hit_tokens?: number;
}

/**
 * Turns Chat Completions chunks into neutral events. `reasoning_content` is
 * kept (never shown) and returned in `providerState`, because DeepSeek
 * rejects a later tool round that leaves it out.
 */
export class DeepSeekStreamMapper {
  private readonly calls = new Map<number, ToolCall>();
  private toolCount = 0;
  private reasoning = '';
  private finishReason: string | null = null;
  /** Text held back: it may be the start of a special-token marker. */
  private heldText = '';
  /** Tool-call markup the model wrote into content (DSML); never shown. */
  private markup: string | null = null;

  constructor(private readonly model: string) {}

  handle(chunk: ChatCompletionChunk): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    const choice = chunk.choices[0];
    if (choice !== undefined) {
      const delta = choice.delta as ChatCompletionChunk.Choice.Delta & DeepSeekDelta;
      if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content;
      if (typeof delta.content === 'string' && delta.content !== '') {
        out.push(...this.text(delta.content));
      }
      for (const tc of delta.tool_calls ?? []) {
        let call = this.calls.get(tc.index);
        if (call === undefined) {
          call = {
            id: tc.id ?? `call_${String(tc.index)}`,
            name: tc.function?.name ?? '',
            args: '',
            open: true,
          };
          this.calls.set(tc.index, call);
          out.push({
            type: 'tool_call_start',
            index: this.toolCount++,
            id: call.id,
            name: call.name,
          });
        }
        const piece = tc.function?.arguments ?? '';
        if (piece !== '') {
          call.args += piece;
          out.push({ type: 'tool_call_delta', id: call.id, argumentsDelta: piece });
        }
      }
      if (choice.finish_reason !== null) {
        this.finishReason = choice.finish_reason;
        out.push(...this.closeCalls(false));
      }
    }
    if (chunk.usage !== null && chunk.usage !== undefined) {
      const u = chunk.usage as typeof chunk.usage & DeepSeekUsage;
      out.push({
        type: 'usage',
        usage: usage({
          inputTokens: u.prompt_tokens,
          cachedReadTokens:
            u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: u.completion_tokens,
          reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        }),
      });
    }
    return out;
  }

  /** Text up to the first special-token marker; the rest is markup. */
  private text(content: string): AiStreamEvent[] {
    if (this.markup !== null) {
      this.markup += content;
      return [];
    }
    const split = splitAtMarker(this.heldText + content);
    this.heldText = split.held;
    if (split.markup !== null) this.markup = split.markup;
    return split.visible === '' ? [] : [{ type: 'text_delta', text: split.visible }];
  }

  /** Tool calls the model wrote as DSML markup in its content. */
  private markupCalls(): AiStreamEvent[] {
    if (this.markup === null) return [];
    const out: AiStreamEvent[] = [];
    for (const invoke of parseDsmlInvokes(this.markup)) {
      const id = `dsml_${String(this.toolCount)}`;
      out.push({ type: 'tool_call_start', index: this.toolCount++, id, name: invoke.name });
      out.push(toolCallEnd(id, invoke.name, invoke.arguments));
    }
    return out;
  }

  private closeCalls(cut: boolean): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    for (const call of this.calls.values()) {
      if (!call.open) continue;
      call.open = false;
      out.push(
        cut
          ? toolCallCut(call.id, call.name, call.args)
          : toolCallEnd(call.id, call.name, call.args),
      );
    }
    return out;
  }

  end(aborted: boolean): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    if (this.heldText !== '') {
      out.push({ type: 'text_delta', text: this.heldText });
      this.heldText = '';
    }
    out.push(...this.closeCalls(true));
    const markupCalls = aborted ? [] : this.markupCalls();
    out.push(...markupCalls);
    if (aborted) {
      out.push({ type: 'finish', reason: 'stopped' });
      return out;
    }
    if (this.finishReason === null) {
      throw new DeepSeekStreamError('stream_truncated', 'The response stream ended early');
    }
    if (this.finishReason === 'insufficient_system_resource') {
      throw new DeepSeekStreamError(
        'insufficient_system_resource',
        'DeepSeek ended the response for lack of capacity',
      );
    }
    const mapped = FINISH_REASONS[this.finishReason] ?? 'end';
    const reason = markupCalls.length > 0 && mapped === 'end' ? 'tool_use' : mapped;
    if (this.reasoning === '') {
      out.push({ type: 'finish', reason });
      return out;
    }
    const opaque: DeepSeekOpaqueState = { reasoningContent: this.reasoning };
    out.push({
      type: 'finish',
      reason,
      providerState: { provider: 'deepseek', model: this.model, opaque },
    });
    return out;
  }
}
