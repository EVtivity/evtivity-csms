// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions.js';

import type { AiProvider, AiResponse, ChatMessage, ChatOptions, ToolDefinition } from './types.js';

export class OpenAiProvider implements AiProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model || 'gpt-4o';
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
    options?: ChatOptions,
  ): Promise<AiResponse> {
    const openaiMessages = this.mapMessages(messages, systemPrompt);

    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: openaiMessages,
    };

    if (options?.temperature != null) params.temperature = options.temperature;
    if (options?.topP != null) params.top_p = options.topP;

    if (tools.length > 0) {
      params.tools = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await this.client.chat.completions.create(params);

    return this.mapResponse(response);
  }

  private mapMessages(messages: ChatMessage[], systemPrompt: string): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else {
        const toolCallId = msg.toolCallId ?? '';
        result.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: msg.content,
        });
      }
    }

    return result;
  }

  private mapResponse(response: OpenAI.ChatCompletion): AiResponse {
    const choice = response.choices[0];
    if (!choice) {
      return { content: null, toolCalls: [], finishReason: 'end' };
    }

    const message = choice.message;
    const content = message.content;
    const toolCalls: AiResponse['toolCalls'] = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.type === 'function') {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          });
        }
      }
    }

    const finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end';

    return { content, toolCalls, finishReason };
  }
}
