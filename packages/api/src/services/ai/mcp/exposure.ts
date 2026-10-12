// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The tools the MCP server offers: the catalog tools
 * whose policy entry is MCP-exposed (`AI_MCP_EXPOSURE` in `tools/policy.ts`),
 * in the categories (OpenAPI tags) the request names with `?toolsets=`, or a
 * core set by default. The order is deterministic (by name).
 *
 * The list is not filtered by the key's permissions: the OpenAPI spec does
 * not carry each route's `authorize()` permission, so a tool the key may not
 * use answers the route's 403 as an `isError` result.
 */

import { AI_MCP_DEFAULT_TOOLSETS } from '@evtivity/lib/ai-proposals';
import type { AiCatalogOperation, AiCatalogTool } from '../tools/catalog-types.js';
import { AI_TOOL_CATALOG } from '../tools/catalog.js';
import { createToolset } from '../tools/execute.js';
import type { Toolset, ToolsetEntry } from '../tools/execute.js';
import { mcpOffers, toolPolicy } from '../tools/policy.js';
import type { ToolPolicy } from '../tools/policy.js';
import { ocppToolDescription, toolOcppVersion } from '../tools/ocpp-version.js';

/** A category name in `?toolsets=`: the tag in lower case, other characters as `-`. */
export function toolsetSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Toolset slugs that have at least one MCP tool, sorted. */
export function mcpToolsetNames(catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG): string[] {
  const names = new Set<string>();
  for (const tool of catalog) {
    if (mcpOffers(tool.operationId)) names.add(toolsetSlug(tool.category));
  }
  return [...names].sort();
}

export type McpToolsetsParse =
  | { ok: true; toolsets: string[] }
  | { ok: false; unknown: string[]; available: string[] };

/** Reads `?toolsets=a,b`: absent or empty is the default set; an unknown name is refused. */
export function parseMcpToolsets(
  value: string | undefined,
  catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG,
): McpToolsetsParse {
  const available = mcpToolsetNames(catalog);
  const requested = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  if (requested.length === 0) {
    return { ok: true, toolsets: AI_MCP_DEFAULT_TOOLSETS.filter((s) => available.includes(s)) };
  }
  const unknown = requested.filter((s) => !available.includes(s));
  if (unknown.length > 0) return { ok: false, unknown, available };
  return { ok: true, toolsets: [...new Set(requested)].sort() };
}

const WRITE_NOTE =
  ' This tool changes the station: it runs at once, with the API key permissions and sites, and answers the command result.';

/** True when `name` is an MCP write tool (listed only while writes are allowed). */
export function isMcpWriteTool(
  name: string,
  catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG,
): boolean {
  const tool = catalog.find((t) => t.name === name);
  return (
    tool !== undefined &&
    mcpOffers(tool.operationId) &&
    toolPolicy(tool.operationId).exposure === 'write'
  );
}

/** The MCP tools of the given toolsets, by name. */
export function mcpToolset(
  toolsets: readonly string[],
  catalog: readonly AiCatalogTool[] = AI_TOOL_CATALOG,
  options: { writes: boolean } = { writes: true },
): Toolset {
  const wanted = new Set(toolsets);
  const entries: ToolsetEntry[] = [];
  for (const tool of catalog) {
    if (!wanted.has(toolsetSlug(tool.category)) || !mcpOffers(tool.operationId)) continue;
    const policy = toolPolicy(tool.operationId);
    // Without write access (setting off, or no aiMcp:write) writes are not listed.
    if (policy.exposure === 'write' && !options.writes) continue;
    const description = ocppToolDescription(tool);
    entries.push({
      tool,
      definition: {
        name: tool.name,
        description: policy.exposure === 'write' ? `${description}.${WRITE_NOTE}` : description,
        // MCP clients send only the arguments they set: the operation's own
        // schema, not the strict one with every property required.
        parameters: tool.validation,
        strict: false,
      },
      fixedArgs: {},
      allowedValues: {},
      omitted: policy.omit,
    });
  }
  return createToolset(entries);
}

/** The MCP tool list: definitions in name order, with read and write hints. */
export function mcpToolList(toolset: Toolset): {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}[] {
  return [...toolset.byName.values()].map((entry) => {
    const write = toolPolicy(entry.tool.operationId).exposure === 'write';
    return {
      name: entry.definition.name,
      description: entry.definition.description,
      // The catalog builds every argument schema as an object.
      inputSchema: { ...entry.definition.parameters, type: 'object' as const },
      annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: false },
    };
  });
}

/**
 * Checks of the MCP exposure against the policy and the catalog (codegen gate,
 * TC-AI-MCP-05): every `read` and `write` entry sets its MCP value, no `never`
 * entry is listed, every listed entry names an operation, and an MCP write is
 * an OCPP command route with a `stationId` argument (MCP writes stay station
 * commands; the route scopes the station to the key user's sites).
 */
export function mcpExposureProblems(
  operations: readonly AiCatalogOperation[],
  tools: readonly AiCatalogTool[],
  policy: Readonly<Record<string, ToolPolicy>>,
  exposure: Readonly<Record<string, boolean>>,
): string[] {
  const problems: string[] = [];
  const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(exposure, id);
  const ids = new Set(operations.map((o) => o.operationId));
  for (const op of operations) {
    const entry = Object.prototype.hasOwnProperty.call(policy, op.operationId)
      ? policy[op.operationId]
      : undefined;
    if (entry === undefined) continue;
    if (entry.exposure === 'never') {
      if (has(op.operationId)) {
        problems.push(`${op.operationId}: a 'never' entry is listed in AI_MCP_EXPOSURE`);
      }
    } else if (!has(op.operationId)) {
      problems.push(
        `${op.operationId}: '${entry.exposure}' entry without an MCP value (add it to AI_MCP_EXPOSURE)`,
      );
    }
  }
  for (const id of Object.keys(exposure)) {
    if (!ids.has(id))
      problems.push(`${id}: AI_MCP_EXPOSURE entry for an operation that does not exist`);
  }
  for (const tool of tools) {
    if (exposure[tool.operationId] !== true) continue;
    if (policy[tool.operationId]?.exposure !== 'write') continue;
    if (toolOcppVersion(tool) === null || !tool.bodyParams.includes('stationId')) {
      problems.push(
        `${tool.operationId}: an MCP write must be an OCPP command route with a stationId argument`,
      );
    }
  }
  return problems;
}
