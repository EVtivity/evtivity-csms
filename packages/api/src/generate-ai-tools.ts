// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Codegen script: reads the OpenAPI spec and generates a typed tools.ts file
 * for the AI assistant with tag-based grouping for two-tier tool selection.
 *
 * Run via: npm run codegen:ai-tools
 *
 * Output structure:
 * - TOOL_CATEGORIES: compact summary for the category selection step
 * - TOOLS_BY_CATEGORY: full tool definitions grouped by tag
 * - TOOL_DEFINITIONS: flat array of all tools (for buildToolRequest lookup)
 */
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env['CORS_ORIGIN'] ??= 'http://localhost';
process.env['JWT_SECRET'] ??= `codegen-${crypto.randomUUID()}`;
process.env['SETTINGS_ENCRYPTION_KEY'] ??= 'codegen-key-32-chars-long!!!!!!';

// Always write a stub tools.ts before importing buildApp. This prevents import
// failures when the generated file is missing exports that assistant.service needs.
// The codegen overwrites this stub with the real generated file at the end.
const stubPath = resolve(__dirname, 'services', 'ai', 'tools.ts');
writeFileSync(
  stubPath,
  [
    "import type { ToolDefinition } from './types.js';",
    'export interface ExtendedToolDefinition extends ToolDefinition { method: string; pathTemplate: string; }',
    'export interface ToolCategory { tag: string; description: string; toolCount: number; toolNames: string[]; }',
    'export const TOOL_CATEGORIES: ToolCategory[] = [];',
    'export function getToolsForCategories(_tags: string[]): ExtendedToolDefinition[] { return []; }',
    'export const TOOL_DEFINITIONS: ExtendedToolDefinition[] = [];',
    'export function buildToolRequest(_n: string, _a: Record<string, unknown>): { method: string; url: string; query: Record<string, string>; body?: Record<string, unknown> } { throw new Error("stub"); }',
    '',
  ].join('\n'),
);

// Dynamic import so the stub is on disk before module resolution
const { buildApp } = await import('./app.js');

interface OpenApiParam {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    enum?: string[];
  };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: Array<Record<string, unknown>>;
  parameters?: OpenApiParam[];
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

// Tags to skip (internal, health, streaming, portal-only)
const SKIP_TAGS = new Set([
  'Health',
  'Portal - Auth',
  'Portal - Chargers',
  'Portal - Driver',
  'Portal - Sessions',
  'Portal - Payments',
  'Portal - Guest',
  'Portal - Support',
  'Portal - Roaming',
]);

// Human-readable category descriptions for the AI
const TAG_DESCRIPTIONS: Record<string, string> = {
  Sites:
    'Manage charging sites/locations: list, create, update, delete sites and their properties.',
  Stations:
    'Manage charging stations: list, details, configuration, EVSE/connectors, firmware, display messages, local auth, images.',
  Sessions: 'View charging sessions: list, details, meter values, transaction events.',
  Dashboard:
    'Dashboard statistics: station counts, energy, revenue, uptime, utilization, peak usage, carbon stats.',
  Drivers: 'Manage drivers: list, create, update, tokens, vehicles, fleets.',
  Users: 'Manage operator users: list, create, update, roles, MFA, AI config.',
  Tokens: 'Manage driver RFID tokens.',
  Payments: 'View and manage payments: records, site payment configs, refunds.',
  Pricing: 'Manage pricing groups, tariffs, and holidays.',
  Reservations: 'Manage charging reservations.',
  Reports: 'Generate and view reports, schedules, NEVI compliance.',
  Settings:
    'System settings: general, security, reCAPTCHA, MFA, SSO, notifications, OCPP, PnC, carbon factors.',
  'Support Cases': 'Manage support cases: list, details, messages, attachments.',
  Notifications: 'Notification settings, templates, OCPP events, driver events, history.',
  OCPP: 'Send OCPP commands to stations, view OCPP schemas and events.',
  'Load Management': 'Site power management: allocation, priorities, panels, circuits.',
  'Smart Charging': 'Charging profile templates: create, push, manage schedules.',
  Fleets: 'Fleet management: list, create, update, members, reservations.',
  Invoices: 'Generate and manage invoices.',
  OCPI: 'OCPI roaming: partners, locations, sessions, CDRs, tariffs.',
  PnC: 'Plug & Charge: certificates, CSR requests, CA management.',
  Events: 'Event stream, alert rules, station events.',
  Webhooks: 'Webhook configuration.',
  Transactions: 'Transaction event history.',
  'Access Logs': 'Operator access audit logs.',
};

function operationIdToToolName(operationId: string): string {
  return operationId.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function buildParamProperty(param: OpenApiParam): Record<string, unknown> {
  const prop: Record<string, unknown> = {};
  const schema = param.schema ?? {};
  prop['type'] = schema.type ?? 'string';
  if (param.description != null) prop['description'] = param.description;
  if (schema.enum != null) prop['enum'] = schema.enum;
  if (schema.type === 'array') prop['items'] = { type: 'string' };
  return prop;
}

interface ToolEntry {
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  tag: string;
  parameters: {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

async function generate(): Promise<void> {
  const app = await buildApp({ logger: false });
  await app.ready();
  const spec = app.swagger() as {
    paths: Record<string, Record<string, OpenApiOperation>>;
  };

  const tools: ToolEntry[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (op.operationId == null) continue;

      const hasBearerAuth = op.security?.some((s) => 'bearerAuth' in s) ?? false;
      if (!hasBearerAuth) continue;

      const tags = op.tags ?? [];
      if (tags.some((t) => SKIP_TAGS.has(t))) continue;
      if (path.includes('/events/stream') || path.includes('/sse')) continue;

      const tag = tags[0] ?? 'Other';

      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];

      for (const param of op.parameters ?? []) {
        if (param.in === 'header' || param.in === 'cookie') continue;
        properties[param.name] = buildParamProperty(param);
        if (param.required === true) required.push(param.name);
      }

      if (op.requestBody?.content != null) {
        const jsonContent = op.requestBody.content['application/json'];
        const bodySchema = jsonContent?.schema;
        if (bodySchema?.properties != null) {
          const bodyProps = bodySchema.properties as Record<string, Record<string, unknown>>;
          for (const [key, val] of Object.entries(bodyProps)) {
            const prop = { ...val };
            delete prop.additionalProperties;
            if (prop.type === 'array' && prop.items == null) {
              prop.items = { type: 'string' };
            }
            properties[key] = prop;
          }
          const bodyRequired = bodySchema.required as string[] | undefined;
          if (bodyRequired != null) {
            for (const r of bodyRequired) {
              if (!required.includes(r)) required.push(r);
            }
          }
        }
      }

      // Ensure all array properties have items (OpenAI requirement)
      for (const prop of Object.values(properties)) {
        if (prop.type === 'array' && prop.items == null) {
          prop.items = { type: 'string' };
        }
      }

      tools.push({
        name: operationIdToToolName(op.operationId),
        description: op.summary ?? op.operationId,
        method: method.toUpperCase(),
        pathTemplate: path,
        tag,
        parameters: { type: 'object', properties, required },
      });
    }
  }

  tools.sort(
    (a, b) =>
      a.tag.localeCompare(b.tag) ||
      a.pathTemplate.localeCompare(b.pathTemplate) ||
      a.method.localeCompare(b.method),
  );

  // Build category summary
  const categoryMap = new Map<string, { tools: string[]; description: string }>();
  for (const tool of tools) {
    const existing = categoryMap.get(tool.tag);
    if (existing != null) {
      existing.tools.push(tool.name);
    } else {
      categoryMap.set(tool.tag, {
        tools: [tool.name],
        description: TAG_DESCRIPTIONS[tool.tag] ?? tool.tag,
      });
    }
  }

  const categories = Array.from(categoryMap.entries()).map(([tag, info]) => ({
    tag,
    description: info.description,
    toolCount: info.tools.length,
    toolNames: info.tools,
  }));

  // Build tools-by-category map (without the tag field for smaller output)
  const toolsByCategory: Record<string, Array<Omit<ToolEntry, 'tag'>>> = {};
  for (const tool of tools) {
    const { tag, ...rest } = tool;
    if (toolsByCategory[tag] == null) toolsByCategory[tag] = [];
    toolsByCategory[tag].push(rest);
  }

  // Generate TypeScript
  const lines: string[] = [
    '// AUTO-GENERATED by generate-ai-tools.ts -- DO NOT EDIT',
    '// Regenerate with: npm run codegen:ai-tools',
    `// Generated: ${new Date().toISOString()} (${String(tools.length)} tools across ${String(categories.length)} categories)`,
    '',
    "import type { ToolDefinition } from './types.js';",
    '',
    'export interface ExtendedToolDefinition extends ToolDefinition {',
    '  method: string;',
    '  pathTemplate: string;',
    '}',
    '',
    'export interface ToolCategory {',
    '  tag: string;',
    '  description: string;',
    '  toolCount: number;',
    '  toolNames: string[];',
    '}',
    '',
    `export const TOOL_CATEGORIES: ToolCategory[] = ${JSON.stringify(categories, null, 2)};`,
    '',
    `const TOOLS_BY_CATEGORY: Record<string, ExtendedToolDefinition[]> = ${JSON.stringify(toolsByCategory, null, 2)};`,
    '',
    '/** Get tool definitions for selected categories. */',
    'export function getToolsForCategories(tags: string[]): ExtendedToolDefinition[] {',
    '  const result: ExtendedToolDefinition[] = [];',
    '  for (const tag of tags) {',
    '    const tools = TOOLS_BY_CATEGORY[tag];',
    '    if (tools != null) result.push(...tools);',
    '  }',
    '  return result;',
    '}',
    '',
    '/** Flat array of all tools for lookup by name. */',
    'const ALL_TOOLS: ExtendedToolDefinition[] = Object.values(TOOLS_BY_CATEGORY).flat();',
    '',
    '/** For backward compatibility. */',
    'export const TOOL_DEFINITIONS = ALL_TOOLS;',
    '',
    'export function buildToolRequest(',
    '  toolName: string,',
    '  args: Record<string, unknown>,',
    '): { method: string; url: string; query: Record<string, string>; body?: Record<string, unknown> } {',
    '  const tool = ALL_TOOLS.find((t) => t.name === toolName);',
    '  if (!tool) throw new Error(`Unknown tool: ${toolName}`);',
    '',
    '  let url = tool.pathTemplate;',
    '  const query: Record<string, string> = {};',
    '  const body: Record<string, unknown> = {};',
    '',
    '  for (const [key, value] of Object.entries(args)) {',
    '    if (value === undefined || value === null) continue;',
    '    const placeholder = `{${key}}`;',
    '    if (url.includes(placeholder)) {',
    '      url = url.replace(placeholder, encodeURIComponent(typeof value === "object" ? JSON.stringify(value) : String(value as string | number | boolean)));',
    "    } else if (tool.method === 'GET') {",
    '      query[key] = typeof value === "object" ? JSON.stringify(value) : String(value as string | number | boolean);',
    '    } else {',
    '      body[key] = value;',
    '    }',
    '  }',
    '',
    "  if (tool.method === 'GET' || Object.keys(body).length === 0) {",
    '    return { method: tool.method, url, query };',
    '  }',
    '  return { method: tool.method, url, query, body };',
    '}',
    '',
  ];

  const outPath = resolve(__dirname, 'services', 'ai', 'tools.ts');
  writeFileSync(outPath, lines.join('\n'));
  console.log(
    `AI tools generated: ${String(tools.length)} tools across ${String(categories.length)} categories -> ${outPath}`,
  );

  await app.close();
}

generate().catch((err: unknown) => {
  console.error('Failed to generate AI tools:', err);
  process.exit(1);
});
