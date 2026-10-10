// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';
import type { AiFinishReason, AiStreamEvent } from '../../core/types.js';
import { usage } from '../shared.js';
import type { GeminiOpaqueState } from './map-request.js';

/** A failure Gemini reported inside the stream. */
export class GeminiStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GeminiStreamError';
  }
}

const REFUSAL_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
]);

/**
 * Turns `generateContentStream` chunks into neutral events. Gemini sends
 * whole function calls (with their real ids), so each call starts and ends
 * in one step. Every received part is kept in order for `providerState`,
 * because thought signatures must go back exactly as received (a signature
 * can arrive on an empty text part).
 */
export class GeminiStreamMapper {
  private readonly parts: Part[] = [];
  private toolCount = 0;
  private malformed = 0;
  private hasSignature = false;
  private finishReason: string | null = null;
  private blocked = false;

  constructor(private readonly model: string) {}

  handle(chunk: GenerateContentResponse): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    if (chunk.promptFeedback?.blockReason !== undefined) this.blocked = true;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      this.parts.push(part);
      if (part.thoughtSignature !== undefined && part.thoughtSignature !== '')
        this.hasSignature = true;
      if (part.thought === true) continue;
      if (typeof part.text === 'string' && part.text !== '')
        out.push({ type: 'text_delta', text: part.text });
      const call = part.functionCall;
      if (call !== undefined) {
        const index = this.toolCount++;
        const id = call.id ?? `call_${String(index)}`;
        const name = call.name ?? '';
        out.push({ type: 'tool_call_start', index, id, name });
        const args = call.args;
        out.push(
          typeof args === 'object' && !Array.isArray(args)
            ? { type: 'tool_call_done', id, name, arguments: args }
            : args === undefined
              ? { type: 'tool_call_done', id, name, arguments: {} }
              : {
                  type: 'tool_call_error',
                  id,
                  name,
                  rawArguments: JSON.stringify(args),
                  message: 'Tool arguments are not a JSON object',
                },
        );
      }
    }
    if (candidate?.finishReason !== undefined) {
      this.finishReason = candidate.finishReason;
      if (candidate.finishReason === FinishReason.MALFORMED_FUNCTION_CALL) {
        // Gemini drops a call it could not form; the engine reports it back to the model.
        out.push({
          type: 'tool_call_error',
          id: `malformed_${String(this.malformed++)}`,
          name: '',
          rawArguments: candidate.finishMessage ?? '',
          message: 'The model produced a malformed function call',
        });
      }
    }
    const u = chunk.usageMetadata;
    if (u !== undefined) {
      const thoughts = u.thoughtsTokenCount ?? 0;
      out.push({
        type: 'usage',
        usage: usage({
          inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
          cachedReadTokens: u.cachedContentTokenCount ?? 0,
          // Neutral output includes reasoning, as the other providers count it.
          outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
          reasoningTokens: thoughts,
        }),
      });
    }
    return out;
  }

  end(aborted: boolean): AiStreamEvent[] {
    if (aborted) return [{ type: 'finish', reason: 'stopped' }];
    let reason: AiFinishReason;
    if (this.blocked) reason = 'refusal';
    else if (this.finishReason === null) {
      throw new GeminiStreamError('stream_truncated', 'The response stream ended early');
    } else if (this.finishReason === 'MAX_TOKENS') reason = 'max_tokens';
    else if (REFUSAL_REASONS.has(this.finishReason)) reason = 'refusal';
    else reason = this.toolCount > 0 ? 'tool_use' : 'end';
    if (!this.hasSignature) return [{ type: 'finish', reason }];
    const opaque: GeminiOpaqueState = { parts: this.parts };
    return [
      { type: 'finish', reason, providerState: { provider: 'gemini', model: this.model, opaque } },
    ];
  }
}
