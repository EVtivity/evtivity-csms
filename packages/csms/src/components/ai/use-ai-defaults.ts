// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';

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
  language: string;
  chatbot: AiSurfaceDefaults;
  support: AiSurfaceDefaults;
  providers: AiProviderModels[];
}

const PROMPT_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];

/** The prompt language for a UI language; anything else gets English. */
export function aiPromptLanguage(language: string | undefined): string {
  return language != null && PROMPT_LANGUAGES.includes(language) ? language : 'en';
}

const ENDPOINTS = {
  settings: '/v1/settings/ai/defaults',
  personal: '/v1/users/me/ai-defaults',
} as const;

/**
 * The built-in prompts (in the UI language), the rules always added and the
 * model registry. Code constants of the running API, so they are fetched
 * once per language. Settings > AI reads the settings route
 * (`settings.ai:read`); the profile AI cards read the `users/me` one.
 */
export function useAiDefaults(scope: keyof typeof ENDPOINTS): AiDefaults | undefined {
  const { i18n } = useTranslation();
  const language = aiPromptLanguage(i18n.language);
  const { data } = useQuery({
    queryKey: ['ai-defaults', scope, language],
    queryFn: () =>
      api.get<AiDefaults>(`${ENDPOINTS[scope]}?language=${encodeURIComponent(language)}`),
    staleTime: Infinity,
  });
  return data;
}

/** Whether the text is the built-in prompt (an unchanged default is not stored). */
export function isDefaultPrompt(text: string, defaults: AiSurfaceDefaults | undefined): boolean {
  return defaults != null && text.replace(/\r\n/g, '\n').trim() === defaults.prompt.trim();
}

/** The model registry entry of a provider, when known. */
export function providerModels(
  defaults: AiDefaults | undefined,
  provider: string,
): AiProviderModels | undefined {
  return defaults?.providers.find((p) => p.id === provider);
}

/** A model id the registry of the provider does not list. */
export function isCustomModel(
  defaults: AiDefaults | undefined,
  provider: string,
  model: string,
): boolean {
  if (model.trim() === '') return false;
  const entry = providerModels(defaults, provider);
  return entry == null || !entry.models.some((m) => m.id === model.trim());
}
