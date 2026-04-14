// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AnthropicProvider } from './anthropic-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { OpenAiProvider } from './openai-provider.js';
import type { AiProvider } from './types.js';

export function createAiProvider(provider: string, apiKey: string, model?: string): AiProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, model);
    case 'openai':
      return new OpenAiProvider(apiKey, model);
    case 'gemini':
      return new GeminiProvider(apiKey, model);
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}
