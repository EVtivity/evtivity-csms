// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Anthropic from '@anthropic-ai/sdk';
import type { AiFinishReason, AiStreamEvent } from '../../core/types.js';
import { parseToolArguments, toolCallCut, toolCallEnd, usage } from '../shared.js';
import type { AnthropicOpaqueState } from './map-request.js';

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted'; data: string }
  | { kind: 'tool'; id: string; name: string; json: string; open: boolean }
  | { kind: 'other' };

const STOP_REASONS: Readonly<Record<Anthropic.StopReason, AiFinishReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  pause_turn: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  model_context_window_exceeded: 'context_exceeded',
};

/**
 * Turns Messages API stream events into neutral events and keeps the turn's
 * content blocks, so thinking blocks and their signatures can be replayed
 * unchanged in the next tool round.
 */
export class AnthropicStreamMapper {
  private readonly blocks = new Map<number, Block>();
  private toolCount = 0;
  private inputTokens = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private outputTokens = 0;
  private thinkingTokens = 0;
  private stopReason: Anthropic.StopReason | null = null;

  constructor(private readonly model: string) {}

  handle(event: Anthropic.RawMessageStreamEvent): AiStreamEvent[] {
    switch (event.type) {
      case 'message_start': {
        const u = event.message.usage;
        this.inputTokens = u.input_tokens;
        this.cacheRead = u.cache_read_input_tokens ?? 0;
        this.cacheWrite = u.cache_creation_input_tokens ?? 0;
        this.outputTokens = u.output_tokens;
        return [];
      }
      case 'content_block_start':
        return this.start(event.index, event.content_block);
      case 'content_block_delta':
        return this.delta(event.index, event.delta);
      case 'content_block_stop': {
        const block = this.blocks.get(event.index);
        if (block?.kind !== 'tool' || !block.open) return [];
        block.open = false;
        return [toolCallEnd(block.id, block.name, block.json)];
      }
      case 'message_delta': {
        const u = event.usage;
        // Fields the delta leaves out keep their message_start values.
        if (typeof u.input_tokens === 'number') this.inputTokens = u.input_tokens;
        if (typeof u.cache_read_input_tokens === 'number')
          this.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === 'number')
          this.cacheWrite = u.cache_creation_input_tokens;
        if (typeof u.output_tokens === 'number') this.outputTokens = u.output_tokens;
        this.thinkingTokens = u.output_tokens_details?.thinking_tokens ?? this.thinkingTokens;
        if (event.delta.stop_reason !== null) this.stopReason = event.delta.stop_reason;
        return [this.usageEvent()];
      }
      case 'message_stop':
        return [];
    }
  }

  private start(
    index: number,
    block: Anthropic.RawContentBlockStartEvent['content_block'],
  ): AiStreamEvent[] {
    switch (block.type) {
      case 'text':
        this.blocks.set(index, { kind: 'text', text: block.text });
        return block.text === '' ? [] : [{ type: 'text_delta', text: block.text }];
      case 'thinking':
        this.blocks.set(index, {
          kind: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        });
        return [];
      case 'redacted_thinking':
        this.blocks.set(index, { kind: 'redacted', data: block.data });
        return [];
      case 'tool_use':
        this.blocks.set(index, {
          kind: 'tool',
          id: block.id,
          name: block.name,
          json: '',
          open: true,
        });
        return [
          { type: 'tool_call_start', index: this.toolCount++, id: block.id, name: block.name },
        ];
      default:
        // Server tool blocks: no server tools are configured, so none are expected.
        this.blocks.set(index, { kind: 'other' });
        return [];
    }
  }

  private delta(index: number, delta: Anthropic.RawContentBlockDelta): AiStreamEvent[] {
    const block = this.blocks.get(index);
    switch (delta.type) {
      case 'text_delta':
        if (block?.kind === 'text') block.text += delta.text;
        return delta.text === '' ? [] : [{ type: 'text_delta', text: delta.text }];
      case 'input_json_delta':
        if (block?.kind !== 'tool') return [];
        block.json += delta.partial_json;
        return delta.partial_json === ''
          ? []
          : [{ type: 'tool_call_delta', id: block.id, argumentsDelta: delta.partial_json }];
      case 'thinking_delta':
        if (block?.kind === 'thinking') block.thinking += delta.thinking;
        return [];
      case 'signature_delta':
        if (block?.kind === 'thinking') block.signature += delta.signature;
        return [];
      case 'citations_delta': {
        const c = delta.citation;
        if (c.type !== 'search_result_location') return [];
        return [{ type: 'citation', citation: { passageId: c.source, citedText: c.cited_text } }];
      }
    }
  }

  private usageEvent(): AiStreamEvent {
    return {
      type: 'usage',
      usage: usage({
        // Neutral input counts every prompt token; cached reads and writes are subsets.
        inputTokens: this.inputTokens + this.cacheRead + this.cacheWrite,
        cachedReadTokens: this.cacheRead,
        cacheWriteTokens: this.cacheWrite,
        outputTokens: this.outputTokens,
        reasoningTokens: this.thinkingTokens,
      }),
    };
  }

  /** Closing events: open tool calls, then `finish` (with the replay state when the turn thought). */
  end(aborted: boolean): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    for (const block of this.blocks.values()) {
      if (block.kind === 'tool' && block.open) {
        block.open = false;
        out.push(toolCallCut(block.id, block.name, block.json));
      }
    }
    if (aborted) {
      out.push({ type: 'finish', reason: 'stopped' });
      return out;
    }
    const reason = this.stopReason === null ? 'end' : STOP_REASONS[this.stopReason];
    const state = this.replayState();
    out.push(
      state === undefined
        ? { type: 'finish', reason }
        : {
            type: 'finish',
            reason,
            providerState: { provider: 'anthropic', model: this.model, opaque: state },
          },
    );
    return out;
  }

  private replayState(): AnthropicOpaqueState | undefined {
    const ordered = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    if (!ordered.some((b) => b.kind === 'thinking' || b.kind === 'redacted')) return undefined;
    const content: AnthropicOpaqueState['content'] = [];
    for (const block of ordered) {
      switch (block.kind) {
        case 'thinking':
          content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
          break;
        case 'redacted':
          content.push({ type: 'redacted_thinking', data: block.data });
          break;
        case 'text':
          if (block.text !== '') content.push({ type: 'text', text: block.text });
          break;
        case 'tool': {
          // A malformed call was already reported as tool_call_error; it replays with empty input.
          const parsed = parseToolArguments(block.json);
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: parsed.ok ? parsed.value : {},
          });
          break;
        }
        case 'other':
          break;
      }
    }
    return { content };
  }
}
