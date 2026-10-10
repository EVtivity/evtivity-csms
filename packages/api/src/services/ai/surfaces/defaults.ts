// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What Settings > AI and the profile AI cards show beside the operator's
 * values: the built-in system prompt per surface in one language, the rules
 * the engine always adds, and the model registry per provider. Code
 * constants only, no settings, keys or site data.
 */

import { listProviderEntries } from '../core/model-registry.js';
import { OCPP_VERSION_RULE, SECURITY_RULES, SUPPORT_BODY_ONLY } from '../engine/prompt.js';
import { defaultSystemPrompt } from '../engine/prompt-defaults.js';
import type { PromptLanguage } from '../engine/prompt-defaults.js';
import type { AiSurface } from '../tools/policy.js';

export interface AiSurfaceDefaults {
  prompt: string;
  fixedRules: string;
}

export interface AiModelOption {
  id: string;
  name: string;
  vision: boolean;
  pdf: boolean;
}

export interface AiProviderModels {
  id: string;
  defaultModel: string;
  modelsDocsUrl: string;
  models: AiModelOption[];
}

export interface AiDefaults {
  language: PromptLanguage;
  chatbot: AiSurfaceDefaults;
  support: AiSurfaceDefaults;
  providers: AiProviderModels[];
}

/** The rules always added for a surface, in the order the prompt has them. */
function fixedRules(surface: AiSurface): string {
  const extra = surface === 'chatbot' ? OCPP_VERSION_RULE : SUPPORT_BODY_ONLY;
  return `${SECURITY_RULES}\n\n${extra}`;
}

export function buildAiDefaults(language: PromptLanguage): AiDefaults {
  return {
    language,
    chatbot: {
      prompt: defaultSystemPrompt('chatbot', language),
      fixedRules: fixedRules('chatbot'),
    },
    support: {
      prompt: defaultSystemPrompt('support', language),
      fixedRules: fixedRules('support'),
    },
    providers: listProviderEntries().map((p) => ({
      id: p.id,
      defaultModel: p.defaultModel,
      modelsDocsUrl: p.modelsDocsUrl,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        vision: m.capabilities.vision !== false,
        pdf: m.capabilities.documents.pdf !== false,
      })),
    })),
  };
}
