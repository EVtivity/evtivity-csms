// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { AiProvider, ChatMessage, ChatOptions } from './types.js';
import type { ExtendedToolDefinition } from './tools.js';
import { buildToolRequest } from './tools.js';

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Shared tool-use loop. Sends messages to the AI provider, executes any tool
 * calls via app.inject(), feeds results back, and repeats until the AI
 * produces a final text response or the iteration limit is reached.
 *
 * Used by both the general chatbot and the support AI assistant.
 */
export async function executeToolLoop(
  app: FastifyInstance,
  provider: AiProvider,
  messages: ChatMessage[],
  tools: ExtendedToolDefinition[],
  systemPrompt: string,
  chatOptions: ChatOptions,
  authHeader: string,
  maxIterations?: number,
): Promise<{ content: string; apiCallsMade: number }> {
  const limit = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const allowedToolNames = new Set(tools.map((t) => t.name));
  let apiCallsMade = 0;

  let response = await provider.chat(messages, tools, systemPrompt, chatOptions);

  while (response.finishReason === 'tool_use' && apiCallsMade < limit) {
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      toolCalls: response.toolCalls,
    });

    const toolResults = await Promise.all(
      response.toolCalls.map(async (toolCall) => {
        try {
          // The AI is constrained to the filtered tools at the prompt layer,
          // but `buildToolRequest` resolves names against the global
          // ALL_TOOLS catalog. Without this check, a prompt-injected model
          // could request a tool name (e.g. a POST/DELETE) that was filtered
          // out of its visible set but still exists in ALL_TOOLS — and we
          // would happily execute it with the caller's auth header. Reject
          // anything outside the caller-supplied whitelist.
          if (!allowedToolNames.has(toolCall.name)) {
            return {
              counted: false,
              message: {
                role: 'tool_result' as const,
                content: JSON.stringify({ error: `Tool not available: ${toolCall.name}` }),
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
            };
          }

          const toolRequest = buildToolRequest(toolCall.name, toolCall.arguments);

          const injectResult = await app.inject({
            method: toolRequest.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
            url: toolRequest.url,
            query: toolRequest.query,
            headers: { authorization: authHeader },
            ...(toolRequest.body != null ? { payload: toolRequest.body } : {}),
          });

          let resultBody: unknown;
          try {
            resultBody = JSON.parse(injectResult.body);
          } catch {
            resultBody = { error: 'Failed to parse response', statusCode: injectResult.statusCode };
          }

          return {
            counted: true,
            message: {
              role: 'tool_result' as const,
              content: JSON.stringify(resultBody),
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            },
          };
        } catch (err) {
          return {
            counted: false,
            message: {
              role: 'tool_result' as const,
              content: JSON.stringify({ error: String(err) }),
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            },
          };
        }
      }),
    );

    for (const { counted, message } of toolResults) {
      if (counted) apiCallsMade++;
      messages.push(message);
    }

    response = await provider.chat(messages, tools, systemPrompt, chatOptions);
  }

  return {
    content: response.content ?? 'I was unable to generate a response.',
    apiCallsMade,
  };
}
