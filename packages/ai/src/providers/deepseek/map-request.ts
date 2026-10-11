// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { stripForeignProviderState } from '../../core/messages.js';
import type {
  AiPart,
  AiProviderState,
  AiRequest,
  Effort,
  ModelCapabilities,
} from '../../core/types.js';
import {
  dataUrl,
  effortFor,
  maxOutputTokens,
  resolveAttachment,
  textDocumentBlock,
} from '../shared.js';

/** `providerState.opaque` of a DeepSeek turn: its `reasoning_content`, sent back in tool rounds. */
export interface DeepSeekOpaqueState {
  reasoningContent: string;
}

/**
 * Effort to `reasoning_effort`. DeepSeek accepts `low`, `high` and `max`
 * (and maps `medium` to `high` itself); `max` is never sent because its
 * reasoning budget would use up the output limit.
 */
const REASONING_EFFORT: Readonly<Record<Effort, 'low' | 'high'>> = {
  low: 'low',
  medium: 'high',
  high: 'high',
};

/** DeepSeek request body: the Chat Completions shape plus its `thinking` switch. */
export type DeepSeekParams = ChatCompletionCreateParamsStreaming & {
  thinking?: { type: 'enabled' | 'disabled' };
};

function readOpaque(state: AiProviderState | undefined): string | undefined {
  const opaque = state?.opaque as Partial<DeepSeekOpaqueState> | undefined;
  return typeof opaque?.reasoningContent === 'string' ? opaque.reasoningContent : undefined;
}

type JsonSchema = Record<string, unknown>;

/**
 * True when the schema already meets DeepSeek strict mode: every object
 * closes and requires all of its properties. DeepSeek strict mode has no
 * null type, so optional fields cannot be rewritten; such tools stay non-strict.
 */
export function isStrictShaped(schema: JsonSchema): boolean {
  if (typeof schema.items === 'object' && schema.items !== null && !Array.isArray(schema.items)) {
    if (!isStrictShaped(schema.items as JsonSchema)) return false;
  }
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && !anyOf.every((s) => isStrictShaped(s as JsonSchema))) return false;
  const props = schema.properties;
  if (schema.type !== 'object' && (typeof props !== 'object' || props === null)) return true;
  if (schema.additionalProperties !== false) return false;
  const properties = (props ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).every(([name, p]) => required.has(name) && isStrictShaped(p));
}

async function userContent(
  req: AiRequest,
  parts: readonly AiPart[],
): Promise<ChatCompletionContentPart[]> {
  const content: ChatCompletionContentPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text !== '') content.push({ type: 'text', text: part.text });
        break;
      case 'image': {
        const file = await resolveAttachment('deepseek', req, part);
        content.push({
          type: 'image_url',
          image_url: { url: dataUrl(part.mime, file.data), detail: 'auto' },
        });
        break;
      }
      case 'document': {
        // PDFs never get here: no DeepSeek model takes them (assertPartsSupported).
        const file = await resolveAttachment('deepseek', req, part);
        content.push({ type: 'text', text: textDocumentBlock(part.name ?? file.name, file.data) });
        break;
      }
      case 'tool_call':
      case 'tool_result':
        break;
    }
  }
  return content;
}

async function chatMessages(req: AiRequest, system: string): Promise<ChatCompletionMessageParam[]> {
  const out: ChatCompletionMessageParam[] = [];
  if (system !== '') out.push({ role: 'system', content: system });
  for (const message of stripForeignProviderState(req.messages, 'deepseek', req.model)) {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      const toolCalls: ChatCompletionMessageToolCall[] = message.parts.flatMap((p) =>
        p.type === 'tool_call'
          ? [
              {
                id: p.id,
                type: 'function' as const,
                function: { name: p.name, arguments: JSON.stringify(p.arguments) },
              },
            ]
          : [],
      );
      const reasoning = readOpaque(message.providerState);
      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        // DeepSeek extension: the turn's reasoning, required in later tool rounds.
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      });
      continue;
    }
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content });
      }
    }
    const content = await userContent(req, message.parts);
    if (content.length === 0) continue;
    const texts = content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
    out.push({
      role: 'user',
      content: texts.length === content.length ? texts.join('\n\n') : content,
    });
  }
  return out;
}

export async function buildDeepSeekParams(
  req: AiRequest,
  caps: ModelCapabilities,
  strictEndpoint: boolean,
): Promise<DeepSeekParams> {
  const systemParts = req.system.map((b) => b.text);
  // DeepSeek has JSON mode but no schema enforcement: the schema goes in the prompt.
  const jsonMode = req.responseSchema !== undefined;
  if (req.responseSchema !== undefined) {
    systemParts.push(
      `Reply with one JSON object that matches this JSON schema:\n${JSON.stringify(req.responseSchema.schema)}`,
    );
  }
  const tools: ChatCompletionTool[] = req.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(strictEndpoint && tool.strict && isStrictShaped(tool.parameters) ? { strict: true } : {}),
    },
  }));
  const effort = effortFor(req, caps);
  return {
    model: req.model,
    messages: await chatMessages(req, systemParts.join('\n\n')),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxOutputTokens(req, caps),
    ...(tools.length > 0 ? { tools } : {}),
    ...(effort !== undefined
      ? { thinking: { type: 'enabled' }, reasoning_effort: REASONING_EFFORT[effort] }
      : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}
