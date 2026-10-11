// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model registry: per provider, the known models with their capability
 * flags and prices, the default model and the router model (category
 * routing). Logic reads capabilities from here, never from a provider name.
 *
 * Values come from the provider docs checked on 2026-10-09 (sources next to
 * each provider). `confirmed: true` means every flag was checked against
 * those docs; a limit the docs do not state keeps a conservative value,
 * named in a comment. `confirmed: false` marks entries with a flag that
 * only a live contract run can settle.
 * A model id an operator types that is not listed gets
 * `UNKNOWN_MODEL_CAPABILITIES` (text and tools only).
 */

import { EFFORTS, PROVIDER_IDS } from './types.js';
import type { ImageMime, ModelCapabilities, ProviderId } from './types.js';

/** Prices in micro-USD per million tokens. Cost math lives in `@evtivity/lib/pricing-engine`. */
export interface ModelPrices {
  inputPerMTok: number;
  /** Null when no cache-read price is published; cached tokens then bill at the input rate. */
  cachedInputPerMTok: number | null;
  outputPerMTok: number;
}

export interface ModelEntry {
  id: string;
  /** Display name from the provider's models page. */
  name: string;
  capabilities: ModelCapabilities;
  /** Null when the price is not published or not yet recorded. */
  prices: ModelPrices | null;
  confirmed: boolean;
  /** ISO date the provider retires the model, when announced. */
  retiresOn?: string;
}

export interface ProviderEntry {
  id: ProviderId;
  /** The provider's official models page, where operators find model ids. */
  modelsDocsUrl: string;
  defaultModel: string;
  routerModel: string;
  models: readonly ModelEntry[];
}

const MB = 1024 * 1024;
const ALL_EFFORTS = EFFORTS;

/** Text and tools only, no effort parameter: safe for any model id. */
export const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  strictTools: false,
  vision: false,
  documents: { pdf: false, text: true },
  caching: 'none',
  structuredOutput: false,
  citations: 'prompted',
  effort: [],
  samplingParams: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 4096,
}) as ModelCapabilities;

const ALL_IMAGES: readonly ImageMime[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const COMMON_IMAGES: readonly ImageMime[] = ['image/jpeg', 'image/png', 'image/webp'];

// Anthropic sources (checked 2026-10-09):
// https://platform.claude.com/docs/en/docs/about-claude/models/overview
// https://platform.claude.com/docs/en/build-with-claude/effort (low to max on all 5.5 models)
// https://platform.claude.com/docs/en/build-with-claude/vision (600 images per request, but
//   above 20 images each must be 2000 px or less, so 20 images at 2576 px is the usable pair)
// https://platform.claude.com/docs/en/build-with-claude/pdf-support
function anthropicModel(id: string, name: string, prices: ModelPrices | null): ModelEntry {
  return {
    id,
    name,
    prices,
    confirmed: true,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      strictTools: true,
      vision: { formats: ALL_IMAGES, maxBytes: 10 * MB, maxLongEdgePx: 2576, maxImages: 20 },
      documents: { pdf: { maxBytes: 32 * MB, maxPages: 600 }, text: true },
      caching: 'explicit',
      structuredOutput: true,
      citations: 'native',
      effort: ALL_EFFORTS,
      samplingParams: false,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
  };
}

// OpenAI sources (checked 2026-10-09):
// https://developers.openai.com/api/docs/models/gpt-6-astra, .../gpt-6.1-sol, .../gpt-6-luna
//   (1.05M context, 128K output, function calling, structured outputs)
// https://developers.openai.com/api/docs/guides/reasoning and .../guides/latest-model (low, medium
//   and high on all three; sampling parameters only at effort `none`, which is never sent)
// https://developers.openai.com/api/docs/guides/images-vision (PNG, JPEG, WEBP, non-animated GIF;
//   up to 1,500 images per request; per-image bytes and pixel limits for these models not stated)
// https://developers.openai.com/api/docs/guides/file-inputs (50 MB per file; pages not stated)
// https://developers.openai.com/api/docs/guides/prompt-caching (automatic)
function openaiModel(id: string, name: string, prices: ModelPrices | null): ModelEntry {
  return {
    id,
    name,
    prices,
    confirmed: true,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      strictTools: true,
      // Not stated: bytes per image and long edge (conservative values).
      vision: { formats: ALL_IMAGES, maxBytes: 10 * MB, maxLongEdgePx: 2048, maxImages: 1500 },
      // Not stated: page limit (conservative value).
      documents: { pdf: { maxBytes: 50 * MB, maxPages: 100 }, text: true },
      caching: 'automatic',
      structuredOutput: true,
      citations: 'prompted',
      effort: ALL_EFFORTS,
      samplingParams: false,
      maxContextTokens: 1_050_000,
      maxOutputTokens: 128_000,
    },
  };
}

// Gemini sources (checked 2026-10-09):
// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash, .../gemini-3.5-flash-lite,
//   .../gemini-3.1-pro-preview (1,048,576 input, 65,536 output)
// https://ai.google.dev/gemini-api/docs/thinking (thinkingLevel low, medium and high on all three)
// https://ai.google.dev/gemini-api/docs/generate-content/function-calling (parallel calls, ids)
// https://ai.google.dev/gemini-api/docs/generate-content/gemini-3 (temperature changes discouraged)
// https://ai.google.dev/gemini-api/docs/generate-content/image-understanding (PNG, JPEG, WEBP;
//   inline data caps the whole request at 20 MB)
// https://ai.google.dev/gemini-api/docs/generate-content/document-processing (50 MB, 1,000 pages)
// https://ai.google.dev/gemini-api/docs/generate-content/structured-output
// https://ai.google.dev/gemini-api/docs/pricing
function geminiModel(id: string, name: string, prices: ModelPrices): ModelEntry {
  return {
    id,
    name,
    prices,
    confirmed: true,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      strictTools: false,
      // Files go inline, and an inline request is at most 20 MB (base64 grows bytes by a third).
      vision: { formats: COMMON_IMAGES, maxBytes: 10 * MB, maxLongEdgePx: 2048, maxImages: 10 },
      documents: { pdf: { maxBytes: 14 * MB, maxPages: 1000 }, text: true },
      caching: 'automatic',
      structuredOutput: true,
      citations: 'prompted',
      effort: ALL_EFFORTS,
      samplingParams: false,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 65_536,
    },
  };
}

// DeepSeek sources (checked 2026-10-09):
// https://api-docs.deepseek.com/api/list-models (deepseek-flash with images, deepseek-v4-pro text)
// https://api-docs.deepseek.com/api/create-chat-completion (1,048,576 context, 393,216 output;
//   image_url parts with JPEG, PNG, GIF, WebP; response_format text or json_object only)
// https://api-docs.deepseek.com/guides/thinking_mode (reasoning_effort low, high, max)
// https://api-docs.deepseek.com/guides/tool_calls (strict mode only on the /beta endpoint)
// https://api-docs.deepseek.com/quick_start/pricing
function deepseekModel(id: string, name: string, vision: boolean, prices: ModelPrices): ModelEntry {
  return {
    id,
    name,
    prices,
    // Parallel tool calls are not documented (no parallel_tool_calls parameter).
    confirmed: false,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: false,
      // Strict mode exists only on the /beta endpoint; the adapter enables it by base URL.
      strictTools: false,
      // Not stated: bytes per image, long edge and image count (conservative values).
      vision: vision
        ? { formats: ALL_IMAGES, maxBytes: 10 * MB, maxLongEdgePx: 2048, maxImages: 5 }
        : false,
      documents: { pdf: false, text: true },
      caching: 'automatic',
      // JSON mode only, no schema enforcement.
      structuredOutput: false,
      citations: 'prompted',
      effort: ALL_EFFORTS,
      samplingParams: false,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 393_216,
    },
  };
}

// DeepSeek entries carry the peak rates (the higher of its off-peak and peak prices).
const REGISTRY: Readonly<Record<ProviderId, ProviderEntry>> = {
  anthropic: {
    id: 'anthropic',
    modelsDocsUrl: 'https://platform.claude.com/docs/en/models/overview',
    defaultModel: 'claude-sonnet-5-5',
    routerModel: 'claude-haiku-5-5',
    models: [
      anthropicModel('claude-opus-5-5', 'Claude Opus 5.5', {
        inputPerMTok: 4_000_000,
        cachedInputPerMTok: 200_000,
        outputPerMTok: 20_000_000,
      }),
      anthropicModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', {
        inputPerMTok: 2_000_000,
        cachedInputPerMTok: 100_000,
        outputPerMTok: 10_000_000,
      }),
      anthropicModel('claude-haiku-5-5', 'Claude Haiku 5.5', {
        inputPerMTok: 100_000,
        cachedInputPerMTok: null,
        outputPerMTok: 500_000,
      }),
      anthropicModel('claude-fable-5-1', 'Claude Fable 5.1', null),
    ],
  },
  openai: {
    id: 'openai',
    modelsDocsUrl: 'https://developers.openai.com/api/docs/models',
    defaultModel: 'gpt-6.1-sol',
    routerModel: 'gpt-6-luna',
    models: [
      openaiModel('gpt-6-astra', 'GPT-6 Astra', {
        inputPerMTok: 10_000_000,
        cachedInputPerMTok: 1_000_000,
        outputPerMTok: 50_000_000,
      }),
      openaiModel('gpt-6.1-sol', 'GPT-6.1 Sol', {
        inputPerMTok: 2_000_000,
        cachedInputPerMTok: 100_000,
        outputPerMTok: 10_000_000,
      }),
      // Prompts over 272K input tokens bill at twice the input and cache rates.
      openaiModel('gpt-6-luna', 'GPT-6 Luna', {
        inputPerMTok: 100_000,
        cachedInputPerMTok: 10_000,
        outputPerMTok: 500_000,
      }),
    ],
  },
  gemini: {
    id: 'gemini',
    modelsDocsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    defaultModel: 'gemini-3.8-flash',
    routerModel: 'gemini-3.5-flash-lite',
    models: [
      // Through 2026-12-31; from 2027-01-01 $1.50 / $0.15 / $7.50.
      geminiModel('gemini-3.8-flash', 'Gemini 3.8 Flash', {
        inputPerMTok: 750_000,
        cachedInputPerMTok: 75_000,
        outputPerMTok: 3_750_000,
      }),
      geminiModel('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', {
        inputPerMTok: 300_000,
        cachedInputPerMTok: 30_000,
        outputPerMTok: 2_500_000,
      }),
      // Prompts of 200K tokens or less; above that $4 / $0.40 / $18.
      geminiModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', {
        inputPerMTok: 2_000_000,
        cachedInputPerMTok: 200_000,
        outputPerMTok: 12_000_000,
      }),
    ],
  },
  deepseek: {
    id: 'deepseek',
    modelsDocsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    defaultModel: 'deepseek-flash',
    routerModel: 'deepseek-flash',
    models: [
      deepseekModel('deepseek-flash', 'DeepSeek Flash', true, {
        inputPerMTok: 300_000,
        cachedInputPerMTok: 6_000,
        outputPerMTok: 1_200_000,
      }),
      deepseekModel('deepseek-v4-pro', 'DeepSeek V4 Pro', false, {
        inputPerMTok: 1_320_000,
        cachedInputPerMTok: 44_000,
        outputPerMTok: 3_960_000,
      }),
    ],
  },
};

export function getProviderEntry(provider: ProviderId): ProviderEntry {
  return REGISTRY[provider];
}

export function listProviderEntries(): ProviderEntry[] {
  return PROVIDER_IDS.map((id) => REGISTRY[id]);
}

export function getModelEntry(provider: ProviderId, model: string): ModelEntry | undefined {
  return REGISTRY[provider].models.find((m) => m.id === model);
}

/** Capabilities of a model; an unlisted model id gets the conservative set. */
export function resolveModelCapabilities(provider: ProviderId, model: string): ModelCapabilities {
  return getModelEntry(provider, model)?.capabilities ?? UNKNOWN_MODEL_CAPABILITIES;
}

/** The configured model, or the provider default when the setting is empty. */
export function resolveModelId(
  provider: ProviderId,
  configured: string | null | undefined,
): string {
  const trimmed = configured?.trim() ?? '';
  return trimmed === '' ? REGISTRY[provider].defaultModel : trimmed;
}
