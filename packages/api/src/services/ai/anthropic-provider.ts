// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Anthropic from '@anthropic-ai/sdk';

import type { AiProvider, AiResponse, ChatMessage, ChatOptions, ToolDefinition } from './types.js';

export class AnthropicProvider implements AiProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model || 'claude-sonnet-4-20250514';
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
    options?: ChatOptions,
  ): Promise<AiResponse> {
    const anthropicMessages = this.mapMessages(messages);
    const anthropicTools = this.mapTools(tools);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
    };
    if (options?.temperature != null) params.temperature = options.temperature;
    if (options?.topP != null) params.top_p = options.topP;
    if (options?.topK != null) params.top_k = options.topK;
    if (anthropicTools.length > 0) {
      params.tools = anthropicTools;
    }

    const response = await this.client.messages.create(params);

    return this.mapResponse(response);
  }

  private mapMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          result.push({ role: 'assistant', content });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else {
        const toolCallId = msg.toolCallId ?? '';
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: msg.content,
            },
          ],
        });
      }
    }

    return result;
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  private mapResponse(response: Anthropic.Message): AiResponse {
    let content: string | null = null;
    const toolCalls: AiResponse['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content = block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    const finishReason = response.stop_reason === 'tool_use' ? 'tool_use' : 'end';

    return { content, toolCalls, finishReason };
  }
}
