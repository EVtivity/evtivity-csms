// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The tools a turn offers, per surface. The chatbot gets the exposed tools
 * of the routed categories. Support assist gets only the case-pinned reads:
 * the case's own ids are filled in by the server, so text a driver wrote
 * cannot steer the draft to another case, station, driver or session
 * (TC-AI-I-02, B14).
 */

import { AI_TOOL_CATALOG } from '../tools/catalog.js';
import type { AiCatalogTool } from '../tools/catalog-types.js';
import { surfaceOffers, toolPolicy } from '../tools/policy.js';
import type { CasePin } from '../tools/policy.js';
import { createToolset } from '../tools/execute.js';
import type { Toolset, ToolsetEntry } from '../tools/execute.js';
import { withPropertyEnum, withoutProperties } from '../tools/schema.js';
import { ocppToolDescription } from '../tools/ocpp-version.js';

/** Providers accept at most 128 tools per request. */
export const MAX_TOOLS_PER_REQUEST = 128;

function definitionOf(tool: AiCatalogTool, schema = tool.parameters): ToolsetEntry['definition'] {
  return {
    name: tool.name,
    description: ocppToolDescription(tool),
    parameters: schema,
    strict: tool.strict,
  };
}

/** Chatbot tools of the routed categories. */
export function chatbotToolset(
  categories: readonly string[],
  catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG,
): Toolset {
  const wanted = new Set(categories);
  const entries: ToolsetEntry[] = [];
  for (const tool of catalog) {
    if (!wanted.has(tool.category)) continue;
    const policy = toolPolicy(tool.operationId);
    if (!surfaceOffers(policy, 'chatbot')) continue;
    entries.push({
      tool,
      definition: definitionOf(tool),
      fixedArgs: {},
      allowedValues: {},
      omitted: policy.omit,
    });
  }
  return createToolset(entries.slice(0, MAX_TOOLS_PER_REQUEST));
}

export interface SupportCaseContext {
  caseId: string;
  stationId: string | null;
  driverId: string | null;
  /** Sessions linked to the case. */
  sessionIds: readonly string[];
}

function pinValue(pin: CasePin, ctx: SupportCaseContext): string | readonly string[] | null {
  switch (pin) {
    case 'case.id':
      return ctx.caseId;
    case 'case.stationId':
      return ctx.stationId;
    case 'case.driverId':
      return ctx.driverId;
    case 'case.sessionIds':
      return ctx.sessionIds.length > 0 ? ctx.sessionIds : null;
  }
}

/**
 * Support assist tools for one case. A tool whose pin has no value (a case
 * without a station, driver or sessions) is left out.
 */
export function supportToolset(
  ctx: SupportCaseContext,
  catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG,
): Toolset {
  const entries: ToolsetEntry[] = [];
  for (const tool of catalog) {
    const policy = toolPolicy(tool.operationId);
    if (!surfaceOffers(policy, 'support') || policy.support === null) continue;
    if (tool.method !== 'GET') continue;
    const fixedArgs: Record<string, string> = {};
    const allowedValues: Record<string, readonly string[]> = {};
    let schema = tool.parameters;
    let available = true;
    for (const [arg, pin] of Object.entries(policy.support.pins)) {
      const value = pinValue(pin, ctx);
      if (value === null) {
        available = false;
        break;
      }
      if (typeof value === 'string') {
        fixedArgs[arg] = value;
        schema = withoutProperties(schema, [arg]);
      } else {
        allowedValues[arg] = value;
        schema = withPropertyEnum(schema, arg, value);
      }
    }
    if (!available) continue;
    entries.push({
      tool,
      definition: definitionOf(tool, schema),
      fixedArgs,
      allowedValues,
      omitted: policy.omit,
    });
  }
  return createToolset(entries);
}
