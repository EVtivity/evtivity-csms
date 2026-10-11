// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Anthropic from '@anthropic-ai/sdk';
import { stripForeignProviderState } from '../../core/messages.js';
import type {
  AiMessage,
  AiPart,
  AiProviderState,
  AiRequest,
  ModelCapabilities,
} from '../../core/types.js';
import {
  effortFor,
  maxOutputTokens,
  resolveAttachment,
  textDocumentBlock,
  toBase64,
} from '../shared.js';

type BlockParam = Anthropic.ContentBlockParam;
type MessageParam = Anthropic.MessageParam;

const EPHEMERAL = { type: 'ephemeral' } as const;

/** `providerState.opaque` of an Anthropic turn: its content blocks, replayed unchanged. */
export interface AnthropicOpaqueState {
  content: BlockParam[];
}

function readOpaque(state: AiProviderState | undefined): BlockParam[] | undefined {
  const opaque = state?.opaque as Partial<AnthropicOpaqueState> | undefined;
  return Array.isArray(opaque?.content) ? opaque.content : undefined;
}

async function partToBlock(req: AiRequest, part: AiPart): Promise<BlockParam | null> {
  switch (part.type) {
    case 'text':
      return part.text === '' ? null : { type: 'text', text: part.text };
    case 'image': {
      const file = await resolveAttachment('anthropic', req, part);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mime,
          data: toBase64(file.data),
        },
      };
    }
    case 'document': {
      const file = await resolveAttachment('anthropic', req, part);
      if (part.mime === 'application/pdf') {
        return {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: toBase64(file.data) },
          ...(part.name !== undefined ? { title: part.name } : {}),
        };
      }
      return { type: 'text', text: textDocumentBlock(part.name ?? file.name, file.data) };
    }
    case 'tool_call':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.arguments };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: [{ type: 'text', text: part.content === '' ? '(empty)' : part.content }],
        is_error: part.isError,
      };
  }
}

async function messageBlocks(req: AiRequest, message: AiMessage): Promise<BlockParam[]> {
  if (message.role === 'assistant') {
    const replay = readOpaque(message.providerState);
    if (replay !== undefined) return replay;
  }
  const blocks: BlockParam[] = [];
  for (const part of message.parts) {
    const block = await partToBlock(req, part);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * Builds the Messages API request. User and tool messages both go out as
 * `user` turns (tool results first, as the API requires); consecutive turns
 * of one role are merged.
 */
export async function buildAnthropicParams(
  req: AiRequest,
  caps: ModelCapabilities,
): Promise<Anthropic.MessageCreateParamsStreaming> {
  const explicitCache = caps.caching === 'explicit';
  const messages: MessageParam[] = [];
  for (const message of stripForeignProviderState(req.messages, 'anthropic', req.model)) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = await messageBlocks(req, message);
    if (blocks.length === 0) continue;
    const last = messages.at(-1);
    if (last !== undefined && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  // One breakpoint after the last static system block caches tools and the static prompt.
  let lastCacheable = -1;
  req.system.forEach((block, i) => {
    if (block.cacheable) lastCacheable = i;
  });
  const system: Anthropic.TextBlockParam[] = req.system.map((block, i) => ({
    type: 'text',
    text: block.text,
    ...(explicitCache && i === lastCacheable ? { cache_control: EPHEMERAL } : {}),
  }));

  const tools: Anthropic.Tool[] = req.tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    ...(tool.strict && caps.strictTools ? { strict: true } : {}),
    ...(explicitCache && i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));

  const effort = effortFor(req, caps);
  const outputConfig: Anthropic.OutputConfig = {
    ...(effort !== undefined ? { effort } : {}),
    ...(req.responseSchema !== undefined && caps.structuredOutput
      ? { format: { type: 'json_schema', schema: req.responseSchema.schema } }
      : {}),
  };

  return {
    model: req.model,
    max_tokens: maxOutputTokens(req, caps),
    messages,
    stream: true,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && !caps.parallelToolCalls
      ? { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
      : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    // Automatic breakpoint on the conversation, after the explicit ones above.
    ...(explicitCache ? { cache_control: EPHEMERAL } : {}),
  };
}
