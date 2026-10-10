// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Category routing: before the main call, the router model picks up to four
 * tool categories for the user's message, so the main call carries tens of
 * tools instead of hundreds. Models with structured output answer a JSON
 * schema; the others are asked for the same JSON object. Unknown names are
 * dropped. An explicit empty list means no tools (a greeting); an answer
 * that was cut off or is not the JSON object falls back to the core
 * categories, so a question that needs data never runs without tools.
 *
 * The message can be in any CSMS language. Deterministic hints
 * (`router-keywords.ts`) add the categories the message clearly names (a
 * station command, sessions, tariffs, drivers) to the model's answer and to
 * the fallback: a reasoning router model can spend its output budget before
 * it answers, which happened for most Chinese and Korean requests. The two
 * OCPP command categories always come together, since the router does not
 * know the station's protocol version.
 */

import { tryParseJson } from '@evtivity/lib';
import type { AiAdapter, AiUsage } from '../core/types.js';
import { emptyUsage } from '../core/collect.js';
import type { AiCatalogCategory } from '../tools/catalog-types.js';
import { OCPP_COMMAND_CATEGORIES, keywordCategories } from './router-keywords.js';

export const MAX_ROUTED_CATEGORIES = 4;

/** Used when the router's answer is unusable. */
export const FALLBACK_CATEGORIES = ['Dashboard', 'Sites', 'Stations', 'Sessions'] as const;

/**
 * Output budget of the router call. Reasoning models (DeepSeek cannot turn
 * thinking off) spend part of it on reasoning before the JSON: DeepSeek used
 * all of an earlier 1024 on most Chinese and Korean requests.
 */
export const ROUTER_MAX_OUTPUT_TOKENS = 4096;

/** The base categories when the model's answer is unusable but the message names some. */
const HINTED_FALLBACK_CATEGORIES = ['Stations', 'Sessions'] as const;

export interface RouteInput {
  adapter: AiAdapter;
  model: string;
  categories: readonly AiCatalogCategory[];
  /** The new user message. */
  message: string;
  /** Earlier user messages of the conversation, newest last (context for follow-ups). */
  recentUserMessages: readonly string[];
  signal: AbortSignal;
}

export interface RouteResult {
  categories: string[];
  usage: AiUsage;
}

const ROUTER_SYSTEM = [
  'You route an operator request to tool categories of an EV charging management API. Pick the categories needed to answer it or carry it out, at most four, or none for a greeting or a question that needs no data.',
  'The request can be in English, German, Spanish, Korean, Simplified Chinese or Traditional Chinese. Classify it by its meaning: the category names and descriptions are in English whatever the language of the request.',
  'A command to a station (reset, restart, unlock, start or stop charging, change availability, charging profile) needs both OCPP command categories.',
  'Decide quickly, without long deliberation. Answer only with a JSON object {"categories": [...]}.',
].join(' ');

/** The OCPP command categories come as a pair: the station's protocol version is unknown here. */
function withCommandPair(tags: readonly string[], known: ReadonlySet<string>): string[] {
  const pair = OCPP_COMMAND_CATEGORIES.filter((t) => known.has(t));
  const out: string[] = [];
  for (const tag of tags) {
    const group = (OCPP_COMMAND_CATEGORIES as readonly string[]).includes(tag) ? pair : [tag];
    for (const t of group) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The routed categories: the message's deterministic hints first, then the
 * model's picks (null when its answer was unusable: the core categories, or
 * stations and sessions when the message names categories), the OCPP command
 * pair kept together, at most four.
 */
export function mergeRoutedCategories(
  message: string,
  picked: readonly string[] | null,
  categories: readonly AiCatalogCategory[],
): string[] {
  const known = new Set(categories.map((c) => c.tag));
  const hints = keywordCategories(message, known);
  const base =
    picked ??
    (hints.length > 0 ? HINTED_FALLBACK_CATEGORIES : FALLBACK_CATEGORIES).filter((t) =>
      known.has(t),
    );
  const merged = withCommandPair([...hints, ...base], known);
  const cut = merged.slice(0, MAX_ROUTED_CATEGORIES);
  // Never keep half of the command pair.
  const pair: readonly string[] = OCPP_COMMAND_CATEGORIES.filter((t) => known.has(t));
  const kept = pair.filter((t) => cut.includes(t)).length;
  return kept > 0 && kept < pair.length ? cut.filter((t) => !pair.includes(t)) : cut;
}

/**
 * Parses `{"categories": [...]}` (or a bare array) and keeps known tags, at
 * most four. Null when the text holds no such list.
 */
export function parseRoutedCategories(
  text: string,
  categories: readonly AiCatalogCategory[],
): string[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  let parsed: unknown = undefined;
  if (start !== -1 && end > start) parsed = tryParseJson(text.slice(start, end + 1));
  if (parsed === undefined && arrayStart !== -1) {
    parsed = tryParseJson(text.slice(arrayStart, text.lastIndexOf(']') + 1));
  }
  const list = Array.isArray(parsed)
    ? (parsed as unknown[])
    : parsed != null && typeof parsed === 'object'
      ? (parsed as { categories?: unknown }).categories
      : undefined;
  if (!Array.isArray(list)) return null;
  const byLower = new Map(categories.map((c) => [c.tag.toLowerCase(), c.tag]));
  const out: string[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'string') continue;
    const tag = byLower.get(item.trim().toLowerCase());
    if (tag !== undefined && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_ROUTED_CATEGORIES) break;
  }
  return out;
}

export async function routeCategories(input: RouteInput): Promise<RouteResult> {
  if (input.categories.length === 0) return { categories: [], usage: emptyUsage() };
  const caps = input.adapter.capabilities(input.model);
  const list = input.categories.map((c) => `- ${c.tag}: ${c.description}`).join('\n');
  const context =
    input.recentUserMessages.length > 0
      ? `Earlier messages:\n${input.recentUserMessages.map((m) => `- ${m.slice(0, 500)}`).join('\n')}\n\n`
      : '';
  const result = await input.adapter.complete(
    {
      model: input.model,
      system: [{ text: `${ROUTER_SYSTEM}\n\nCategories:\n${list}`, cacheable: true }],
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: `${context}Message:\n${input.message.slice(0, 4000)}` }],
        },
      ],
      tools: [],
      effort: 'low',
      maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      ...(caps.structuredOutput
        ? {
            responseSchema: {
              name: 'tool_categories',
              schema: {
                type: 'object',
                properties: {
                  categories: {
                    type: 'array',
                    items: { type: 'string', enum: input.categories.map((c) => c.tag) },
                    maxItems: MAX_ROUTED_CATEGORIES,
                  },
                },
                required: ['categories'],
                additionalProperties: false,
              },
            },
          }
        : {}),
    },
    input.signal,
  );
  const parsed =
    result.finishReason === 'end' ? parseRoutedCategories(result.text, input.categories) : null;
  return {
    categories: mergeRoutedCategories(input.message, parsed, input.categories),
    usage: result.usage,
  };
}
