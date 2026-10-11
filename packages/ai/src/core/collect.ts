// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  AiCitation,
  AiFinishReason,
  AiProviderState,
  AiResult,
  AiStreamEvent,
  AiToolCallError,
  AiToolCallPart,
  AiUsage,
} from './types.js';

export function emptyUsage(): AiUsage {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

/** Sums the usage of several model calls (one turn makes one call per tool round). */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * Accumulates stream events into a result. Usable incrementally (the engine
 * forwards each event to the client and keeps the partial result when the
 * client stops the turn).
 */
export class AiStreamAccumulator {
  private text = '';
  private readonly toolCalls: AiToolCallPart[] = [];
  private readonly toolCallErrors: AiToolCallError[] = [];
  private readonly citations: AiCitation[] = [];
  private usage: AiUsage = emptyUsage();
  private finishReason: AiFinishReason | null = null;
  private providerState: AiProviderState | undefined;

  push(event: AiStreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.text += event.text;
        return;
      case 'tool_call_done':
        this.toolCalls.push({
          type: 'tool_call',
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        return;
      case 'tool_call_error':
        this.toolCallErrors.push({
          id: event.id,
          name: event.name,
          rawArguments: event.rawArguments,
          message: event.message,
        });
        return;
      case 'citation':
        this.citations.push(event.citation);
        return;
      case 'usage':
        this.usage = event.usage;
        return;
      case 'finish':
        this.finishReason = event.reason;
        if (event.providerState !== undefined) this.providerState = event.providerState;
        return;
      case 'tool_call_start':
      case 'tool_call_delta':
        return;
    }
  }

  get finished(): boolean {
    return this.finishReason !== null;
  }

  /** The result so far. A stream without a `finish` event counts as `stopped`. */
  result(): AiResult {
    const out: AiResult = {
      text: this.text,
      toolCalls: [...this.toolCalls],
      toolCallErrors: [...this.toolCallErrors],
      citations: [...this.citations],
      usage: { ...this.usage },
      finishReason: this.finishReason ?? 'stopped',
    };
    if (this.providerState !== undefined) out.providerState = this.providerState;
    return out;
  }
}

/** Drains a stream into a result. Adapters build `complete` on this. */
export async function collectAiStream(events: AsyncIterable<AiStreamEvent>): Promise<AiResult> {
  const acc = new AiStreamAccumulator();
  for await (const event of events) acc.push(event);
  return acc.result();
}
