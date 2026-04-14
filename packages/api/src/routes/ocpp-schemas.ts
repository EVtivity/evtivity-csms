// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  ActionRegistry,
  type ActionName,
  ActionRegistry16,
  type ActionName16,
} from '@evtivity/ocpp';
import { errorResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS_DIR = join(currentDir, '..', '..', '..', '..', 'schemas', 'ocpp-2.1');
const SCHEMAS_DIR_16 = join(currentDir, '..', '..', '..', '..', 'schemas', 'ocpp-1.6');

// ---------------------------------------------------------------------------
// JSON Schema -> CommandDef processing
// ---------------------------------------------------------------------------

interface SchemaProperty {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: { $ref?: string; type?: string };
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface SchemaDefinition {
  type?: string;
  enum?: string[];
  description?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface RawSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  definitions?: Record<string, SchemaDefinition>;
}

interface CommandFieldDef {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'datetime';
  required: boolean;
  values?: string[];
  default?: unknown;
  description: string;
  fields?: CommandFieldDef[] | undefined;
}

interface CommandDef {
  action: string;
  version: string;
  fields: CommandFieldDef[];
  example: Record<string, unknown>;
}

const schemaCache = new Map<string, RawSchema>();

async function loadSchema(filePath: string): Promise<RawSchema | null> {
  const cached = schemaCache.get(filePath);
  if (cached != null) return cached;
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as RawSchema;
    schemaCache.set(filePath, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function resolveRef(ref: string): string {
  return ref.replace('#/definitions/', '');
}

function resolvePropertyField(
  name: string,
  prop: SchemaProperty,
  required: boolean,
  definitions: Record<string, SchemaDefinition>,
): CommandFieldDef | null {
  if (name === 'customData') return null;

  if (prop.$ref != null) {
    const defName = resolveRef(prop.$ref);
    const def = definitions[defName];
    if (def == null) return { name, type: 'string', required, description: '' };

    if (def.enum != null) {
      return {
        name,
        type: 'enum',
        required,
        values: def.enum,
        default: def.enum[0],
        description: cleanDescription(def.description),
      };
    }

    if (def.type === 'object' && def.properties != null) {
      const subFields = resolveProperties(def.properties, def.required ?? [], definitions);
      return {
        name,
        type: 'object',
        required,
        description: cleanDescription(def.description),
        fields: subFields,
      };
    }

    return { name, type: 'string', required, description: cleanDescription(def.description) };
  }

  if (prop.type === 'array' && prop.items != null) {
    let subFields: CommandFieldDef[] | undefined;
    if (prop.items.$ref != null) {
      const defName = resolveRef(prop.items.$ref);
      const def = definitions[defName];
      if (def?.type === 'object' && def.properties != null) {
        subFields = resolveProperties(def.properties, def.required ?? [], definitions);
      }
    }
    return {
      name,
      type: 'array',
      required,
      description: cleanDescription(prop.description),
      fields: subFields,
    };
  }

  if (prop.type === 'string' && prop.enum != null) {
    return {
      name,
      type: 'enum',
      required,
      values: prop.enum,
      default: prop.enum[0],
      description: cleanDescription(prop.description),
    };
  }

  if (prop.type === 'string' && prop.format === 'date-time') {
    return { name, type: 'datetime', required, description: cleanDescription(prop.description) };
  }

  if (prop.type === 'integer') {
    return { name, type: 'integer', required, description: cleanDescription(prop.description) };
  }

  if (prop.type === 'number') {
    return { name, type: 'number', required, description: cleanDescription(prop.description) };
  }

  if (prop.type === 'boolean') {
    return { name, type: 'boolean', required, description: cleanDescription(prop.description) };
  }

  return { name, type: 'string', required, description: cleanDescription(prop.description) };
}

function resolveProperties(
  properties: Record<string, SchemaProperty>,
  required: string[],
  definitions: Record<string, SchemaDefinition>,
): CommandFieldDef[] {
  const fields: CommandFieldDef[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const field = resolvePropertyField(name, prop, required.includes(name), definitions);
    if (field != null) fields.push(field);
  }
  return fields;
}

function cleanDescription(desc: string | undefined): string {
  if (desc == null) return '';
  return desc.replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildDefaultValue(field: CommandFieldDef): unknown {
  switch (field.type) {
    case 'enum':
      return field.values?.[0] ?? '';
    case 'integer':
      return 0;
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'datetime':
      return new Date().toISOString();
    case 'string':
      return '';
    case 'array':
      return [];
    case 'object': {
      if (field.fields == null || field.fields.length === 0) return {};
      const obj: Record<string, unknown> = {};
      for (const sub of field.fields) {
        if (sub.required) {
          obj[sub.name] = buildDefaultValue(sub);
        }
      }
      return obj;
    }
    default:
      return '';
  }
}

function buildExample(fields: CommandFieldDef[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.required) {
      example[field.name] = buildDefaultValue(field);
    }
  }
  return example;
}

function schemaToCommandDef(action: string, version: string, schema: RawSchema): CommandDef {
  const fields = resolveProperties(
    schema.properties ?? {},
    schema.required ?? [],
    schema.definitions ?? {},
  );
  return {
    action,
    version,
    fields,
    example: buildExample(fields),
  };
}

// Cache processed CommandDefs
const commandDefCache = new Map<string, CommandDef>();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function ocppSchemaRoutes(app: FastifyInstance): void {
  // Raw JSON schema endpoint (existing)
  app.get(
    '/ocpp/schemas/:action',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP'],
        summary: 'Get JSON schema for an OCPP action',
        operationId: 'getOcppSchema',
        security: [{ bearerAuth: [] }],
        response: { 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { action } = request.params as { action: string };
      const { version } = request.query as { version?: string };
      const is16 = version === 'ocpp1.6';

      const registry = is16 ? ActionRegistry16 : ActionRegistry;
      const entry = registry[action as ActionName & ActionName16] as
        | { validateRequest: (p: unknown) => boolean }
        | undefined;
      if (entry == null) {
        return reply.status(404).send({
          error: 'Unknown OCPP action',
          code: 'UNKNOWN_ACTION',
        });
      }

      const filePath = is16
        ? join(SCHEMAS_DIR_16, `${action}.json`)
        : join(SCHEMAS_DIR, `${action}Request.json`);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return reply.status(404).send({
          error: 'Schema not found',
          code: 'SCHEMA_NOT_FOUND',
        });
      }

      void reply.header('Cache-Control', 'public, max-age=86400');
      void reply.header('Content-Type', 'application/json');
      return reply.send(content);
    },
  );

  // Processed schema endpoints (new)
  async function handleSchemaRequest(
    request: { params: unknown },
    reply: {
      status: (code: number) => { send: (body: unknown) => unknown };
      header: (name: string, value: string) => unknown;
      send: (body: unknown) => unknown;
    },
    is16: boolean,
  ): Promise<unknown> {
    const { action } = request.params as { action: string };
    const version = is16 ? 'ocpp1.6' : 'ocpp2.1';

    const registry = is16 ? ActionRegistry16 : ActionRegistry;
    const entry = registry[action as ActionName & ActionName16] as
      | { validateRequest: (p: unknown) => boolean }
      | undefined;
    if (entry == null) {
      return reply.status(404).send({
        error: 'Unknown OCPP action',
        code: 'UNKNOWN_ACTION',
      });
    }

    const cacheKey = `${version}:${action}`;
    const cached = commandDefCache.get(cacheKey);
    if (cached != null) {
      void reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(cached);
    }

    const filePath = is16
      ? join(SCHEMAS_DIR_16, `${action}.json`)
      : join(SCHEMAS_DIR, `${action}Request.json`);
    const schema = await loadSchema(filePath);
    if (schema == null) {
      return reply.status(404).send({
        error: 'Schema not found',
        code: 'SCHEMA_NOT_FOUND',
      });
    }

    const commandDef = schemaToCommandDef(action, version, schema);
    commandDefCache.set(cacheKey, commandDef);

    void reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(commandDef);
  }

  app.get(
    '/ocpp/commands/v21/:action/schema',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP 2.1 Commands'],
        summary: 'Get processed schema for an OCPP 2.1 command',
        operationId: 'getOcppV21CommandSchema',
        security: [{ bearerAuth: [] }],
        response: { 404: errorResponse },
      },
    },
    async (request, reply) =>
      handleSchemaRequest(
        request,
        reply as {
          status: (code: number) => { send: (body: unknown) => unknown };
          header: (name: string, value: string) => unknown;
          send: (body: unknown) => unknown;
        },
        false,
      ),
  );

  app.get(
    '/ocpp/commands/v16/:action/schema',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP 1.6 Commands'],
        summary: 'Get processed schema for an OCPP 1.6 command',
        operationId: 'getOcppV16CommandSchema',
        security: [{ bearerAuth: [] }],
        response: { 404: errorResponse },
      },
    },
    async (request, reply) =>
      handleSchemaRequest(
        request,
        reply as {
          status: (code: number) => { send: (body: unknown) => unknown };
          header: (name: string, value: string) => unknown;
          send: (body: unknown) => unknown;
        },
        true,
      ),
  );
}
