// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'end' | 'tool_use';
}

export interface ChatOptions {
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
}

export interface AiProvider {
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
    options?: ChatOptions,
  ): Promise<AiResponse>;
}
