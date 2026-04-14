// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclarationSchema,
  type GenerateContentRequest,
  type Part,
} from '@google/generative-ai';

import type { AiProvider, AiResponse, ChatMessage, ChatOptions, ToolDefinition } from './types.js';

export class GeminiProvider implements AiProvider {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, model?: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model || 'gemini-2.0-flash';
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
    options?: ChatOptions,
  ): Promise<AiResponse> {
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemPrompt,
    });

    const contents = this.mapMessages(messages);

    const request: GenerateContentRequest = { contents };

    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature != null) generationConfig.temperature = options.temperature;
    if (options?.topP != null) generationConfig.topP = options.topP;
    if (options?.topK != null) generationConfig.topK = options.topK;
    if (Object.keys(generationConfig).length > 0) {
      request.generationConfig = generationConfig;
    }

    if (tools.length > 0) {
      request.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as unknown as FunctionDeclarationSchema,
          })),
        },
      ];
      request.toolConfig = {
        functionCallingConfig: { mode: FunctionCallingMode.AUTO },
      };
    }

    const result = await model.generateContent(request);

    return this.mapResponse(result.response);
  }

  private mapMessages(messages: ChatMessage[]): Content[] {
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
        }
        contents.push({ role: 'model', parts });
      } else {
        const toolName = msg.toolName ?? '';
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: toolName,
                response: JSON.parse(msg.content) as Record<string, unknown>,
              },
            },
          ],
        });
      }
    }

    return contents;
  }

  private mapResponse(response: { candidates?: Array<{ content: Content }> }): AiResponse {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      return { content: null, toolCalls: [], finishReason: 'end' };
    }

    let content: string | null = null;
    const toolCalls: AiResponse['toolCalls'] = [];

    for (const part of candidate.content.parts) {
      if ('text' in part && part.text) {
        content = (content || '') + part.text;
      }
      if ('functionCall' in part) {
        toolCalls.push({
          id: `gemini-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args as Record<string, unknown>,
        });
      }
    }

    const finishReason = toolCalls.length > 0 ? 'tool_use' : 'end';

    return { content, toolCalls, finishReason };
  }
}
