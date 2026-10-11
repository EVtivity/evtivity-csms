// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ThinkingLevel } from '@google/genai';
import type { Content, GenerateContentParameters, Part } from '@google/genai';
import { stripForeignProviderState } from '../../core/messages.js';
import type {
  AiPart,
  AiProviderState,
  AiRequest,
  Effort,
  ModelCapabilities,
} from '../../core/types.js';
import {
  effortFor,
  maxOutputTokens,
  resolveAttachment,
  textDocumentBlock,
  toBase64,
} from '../shared.js';

/** `providerState.opaque` of a Gemini turn: its parts as received, thought signatures included. */
export interface GeminiOpaqueState {
  parts: Part[];
}

const THINKING_LEVEL: Readonly<Record<Effort, ThinkingLevel>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Signature Gemini documents for function calls it did not produce (history
 * from another provider or model), so its signature check accepts them.
 * Copied verbatim, space included, from
 * https://ai.google.dev/gemini-api/docs/generate-content/gemini-3 (checked 2026-10-09).
 * A live Gemini contract run has not confirmed it yet.
 */
export const GEMINI_FOREIGN_CALL_SIGNATURE = 'context_engineering_is_the_way to_go';

function readOpaque(state: AiProviderState | undefined): Part[] | undefined {
  const opaque = state?.opaque as Partial<GeminiOpaqueState> | undefined;
  return Array.isArray(opaque?.parts) ? opaque.parts : undefined;
}

async function partToGemini(
  req: AiRequest,
  part: AiPart,
  firstCall: boolean,
): Promise<Part | null> {
  switch (part.type) {
    case 'text':
      return part.text === '' ? null : { text: part.text };
    case 'image': {
      const file = await resolveAttachment('gemini', req, part);
      return { inlineData: { mimeType: part.mime, data: toBase64(file.data) } };
    }
    case 'document': {
      const file = await resolveAttachment('gemini', req, part);
      if (part.mime === 'application/pdf') {
        return { inlineData: { mimeType: 'application/pdf', data: toBase64(file.data) } };
      }
      return { text: textDocumentBlock(part.name ?? file.name, file.data) };
    }
    case 'tool_call':
      return {
        functionCall: { id: part.id, name: part.name, args: part.arguments },
        // Only the first call of a turn carries a signature.
        ...(firstCall ? { thoughtSignature: GEMINI_FOREIGN_CALL_SIGNATURE } : {}),
      };
    case 'tool_result':
      // Wrapped, never parsed: the result is untrusted text.
      return {
        functionResponse: {
          id: part.toolCallId,
          name: part.name,
          response: part.isError ? { error: part.content } : { result: part.content },
        },
      };
  }
}

async function contents(req: AiRequest): Promise<Content[]> {
  const out: Content[] = [];
  for (const message of stripForeignProviderState(req.messages, 'gemini', req.model)) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    let parts: Part[] | undefined =
      role === 'model' ? readOpaque(message.providerState) : undefined;
    if (parts === undefined) {
      parts = [];
      let firstCall = true;
      for (const part of message.parts) {
        const mapped = await partToGemini(req, part, role === 'model' && firstCall);
        if (part.type === 'tool_call') firstCall = false;
        if (mapped !== null) parts.push(mapped);
      }
    }
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === role && last.parts !== undefined) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  }
  return out;
}

export async function buildGeminiParams(
  req: AiRequest,
  caps: ModelCapabilities,
  signal: AbortSignal,
): Promise<GenerateContentParameters> {
  const system = req.system.map((b) => b.text).join('\n\n');
  const effort = effortFor(req, caps);
  return {
    model: req.model,
    contents: await contents(req),
    config: {
      abortSignal: signal,
      maxOutputTokens: maxOutputTokens(req, caps),
      ...(system !== '' ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(req.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      ...(effort !== undefined
        ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[effort] } }
        : {}),
      ...(req.responseSchema !== undefined && caps.structuredOutput
        ? { responseMimeType: 'application/json', responseJsonSchema: req.responseSchema.schema }
        : {}),
    },
  };
}
