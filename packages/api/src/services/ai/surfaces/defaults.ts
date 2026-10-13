// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What Settings > AI and the profile AI cards show beside the operator's
 * values: the built-in system prompt per surface in one language, the rules
 * the engine always adds, and the model registry per provider. Code
 * constants only, no settings, keys or site data.
 */

import { listProviderEntries } from '@evtivity/ai/core';
import {
  DOCS_SEARCH_RULE,
  OCPP_VERSION_RULE,
  SECURITY_RULES,
  SUPPORT_BODY_ONLY,
} from '../engine/prompt.js';
import { defaultSystemPrompt } from '../engine/prompt-defaults.js';
import { defaultOpsPrompt, OPS_SECURITY_RULES } from '@evtivity/services/ai-ops-prompt';
import { DRIVER_AI_RULES, defaultDriverAiPrompt } from '@evtivity/services/driver-ai-prompt';
import type { PromptLanguage } from '@evtivity/ai/prompt';
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
  /** System-initiated runs (automatic insights, background workers). */
  ops: AiSurfaceDefaults;
  /** Driver support analyses (portal and mobile app). */
  driver: AiSurfaceDefaults;
  providers: AiProviderModels[];
}

/** The rules always added for a surface, in the order the prompt has them. */
function fixedRules(surface: AiSurface): string {
  return surface === 'chatbot'
    ? `${SECURITY_RULES}\n\n${OCPP_VERSION_RULE}\n\n${DOCS_SEARCH_RULE}`
    : `${SECURITY_RULES}\n\n${DOCS_SEARCH_RULE}\n\n${SUPPORT_BODY_ONLY}`;
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
    ops: {
      prompt: defaultOpsPrompt(language),
      fixedRules: OPS_SECURITY_RULES,
    },
    driver: {
      prompt: defaultDriverAiPrompt(language),
      fixedRules: `${OPS_SECURITY_RULES}\n\n${DRIVER_AI_RULES}`,
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
