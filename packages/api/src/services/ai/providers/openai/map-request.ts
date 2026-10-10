// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from 'openai/resources/responses/responses';
import { stripForeignProviderState } from '../../core/messages.js';
import type { AiProviderState, AiRequest, ModelCapabilities } from '../../core/types.js';
import {
  dataUrl,
  effortFor,
  maxOutputTokens,
  resolveAttachment,
  textDocumentBlock,
} from '../shared.js';

/** `providerState.opaque` of an OpenAI turn: its output items (encrypted reasoning included). */
export interface OpenAiOpaqueState {
  items: ResponseInputItem[];
}

function readOpaque(state: AiProviderState | undefined): ResponseInputItem[] | undefined {
  const opaque = state?.opaque as Partial<OpenAiOpaqueState> | undefined;
  return Array.isArray(opaque?.items) ? opaque.items : undefined;
}

type JsonSchema = Record<string, unknown>;

function isObjectSchema(schema: JsonSchema): boolean {
  return (
    schema.type === 'object' ||
    (typeof schema.properties === 'object' && schema.properties !== null)
  );
}

function nullable(schema: JsonSchema): JsonSchema {
  const type: unknown = schema.type;
  if (typeof type === 'string')
    return type === 'null' ? schema : { ...schema, type: [type, 'null'] };
  if (Array.isArray(type)) {
    const types = type as unknown[];
    return types.includes('null') ? schema : { ...schema, type: [...types, 'null'] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * Strict function schema: every object closes (`additionalProperties: false`)
 * and lists every property as required; a property that was optional
 * becomes nullable, so the model sends `null` instead of leaving it out.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (typeof out.items === 'object' && out.items !== null && !Array.isArray(out.items)) {
    out.items = toStrictSchema(out.items as JsonSchema);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((s) => toStrictSchema(s as JsonSchema));
  }
  if (!isObjectSchema(out)) return out;
  const properties = (out.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
  const strictProps: Record<string, JsonSchema> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const strictProp = toStrictSchema(prop);
    strictProps[name] = required.has(name) ? strictProp : nullable(strictProp);
  }
  out.properties = strictProps;
  out.required = Object.keys(strictProps);
  out.additionalProperties = false;
  return out;
}

async function userContent(
  req: AiRequest,
  parts: AiRequest['messages'][number]['parts'],
): Promise<ResponseInputMessageContentList> {
  const content: ResponseInputMessageContentList = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text !== '') content.push({ type: 'input_text', text: part.text });
        break;
      case 'image': {
        const file = await resolveAttachment('openai', req, part);
        content.push({
          type: 'input_image',
          detail: 'auto',
          image_url: dataUrl(part.mime, file.data),
        });
        break;
      }
      case 'document': {
        const file = await resolveAttachment('openai', req, part);
        if (part.mime === 'application/pdf') {
          content.push({
            type: 'input_file',
            filename: part.name ?? file.name ?? 'document.pdf',
            file_data: dataUrl('application/pdf', file.data),
          });
        } else {
          content.push({
            type: 'input_text',
            text: textDocumentBlock(part.name ?? file.name, file.data),
          });
        }
        break;
      }
      case 'tool_call':
      case 'tool_result':
        break;
    }
  }
  return content;
}

async function inputItems(req: AiRequest): Promise<ResponseInputItem[]> {
  const items: ResponseInputItem[] = [];
  for (const message of stripForeignProviderState(req.messages, 'openai', req.model)) {
    if (message.role === 'assistant') {
      const replay = readOpaque(message.providerState);
      if (replay !== undefined) {
        items.push(...replay);
        continue;
      }
      for (const part of message.parts) {
        if (part.type === 'text' && part.text !== '') {
          items.push({ role: 'assistant', content: part.text });
        } else if (part.type === 'tool_call') {
          items.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments),
          });
        }
      }
      continue;
    }
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: part.content,
        });
      }
    }
    const content = await userContent(req, message.parts);
    if (content.length > 0) items.push({ role: 'user', content });
  }
  return items;
}

/** Builds a stateless Responses API request (`store: false`, encrypted reasoning returned). */
export async function buildOpenAiParams(
  req: AiRequest,
  caps: ModelCapabilities,
): Promise<ResponseCreateParamsStreaming> {
  const tools: FunctionTool[] = req.tools.map((tool) => {
    const strict = tool.strict && caps.strictTools;
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: strict ? toStrictSchema(tool.parameters) : tool.parameters,
      strict,
    };
  });
  const effort = effortFor(req, caps);
  const instructions = req.system.map((b) => b.text).join('\n\n');
  return {
    model: req.model,
    input: await inputItems(req),
    stream: true,
    store: false,
    max_output_tokens: maxOutputTokens(req, caps),
    ...(instructions !== '' ? { instructions } : {}),
    ...(tools.length > 0 ? { tools, parallel_tool_calls: caps.parallelToolCalls } : {}),
    ...(effort !== undefined
      ? { reasoning: { effort }, include: ['reasoning.encrypted_content'] }
      : {}),
    ...(req.cacheKey !== undefined ? { prompt_cache_key: req.cacheKey } : {}),
    ...(req.responseSchema !== undefined && caps.structuredOutput
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: req.responseSchema.name,
              schema: toStrictSchema(req.responseSchema.schema),
              strict: true,
            },
          },
        }
      : {}),
  };
}
