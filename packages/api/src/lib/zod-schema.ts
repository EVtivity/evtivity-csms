// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { ValidationError } from '@evtivity/lib';
import { validationMessage } from './validation-messages.js';

// Every Zod message the API process writes (a request parsed with
// parseZodRequest, a schema check in a route) uses the API's own stable
// wording, not the wording of the Zod release. A message a schema sets wins.
z.config({ customError: validationMessage });

type JsonNode = Record<string, unknown>;

/**
 * The JSON Schema (OpenAPI 3.0) of a Zod schema, for Fastify: Ajv validates
 * requests with it, fast-json-stringify writes responses with it, and
 * @fastify/swagger publishes it. It is the request (input) side of the schema:
 * a field with a default is optional and carries the default, a transform
 * renders its input.
 *
 * Kept to the rules the routes were written against:
 * - A plain object refuses keys it does not name (`additionalProperties:
 *   false`), so Ajv's `removeAdditional` strips them; a loose object allows
 *   any (`true`).
 * - A string format (email, uuid, url, date-time, ...) is the JSON Schema
 *   `format` alone, which Ajv checks; Zod's own regex for it is not added, so
 *   Ajv keeps accepting what the format accepts (an offset date-time, for one).
 * - An integer carries no implicit safe integer bounds.
 * - A date is a date-time string.
 * - A nullable enum lists null (`allowNullInNullableEnums`).
 */
export function zodSchema(schema: z.ZodType): JsonNode {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
    override: ({ zodSchema: node, jsonSchema: json }) => {
      keepConverterRules(node, json);
    },
  }) as JsonNode;
  allowNullInNullableEnums(jsonSchema);
  return jsonSchema;
}

/**
 * The loose form of an object schema with its description. Zod keeps metadata
 * per schema instance, so `.loose()` alone returns an undescribed copy.
 */
export function looseDescribed<T extends z.ZodObject>(schema: T): ReturnType<T['loose']> {
  const loose = schema.loose() as ReturnType<T['loose']>;
  return schema.description != null ? loose.describe(schema.description) : loose;
}

/** The string formats published as a JSON Schema `format` without a pattern. */
const FORMATS_WITHOUT_PATTERN = new Set([
  'email',
  'uuid',
  'guid',
  'url',
  'datetime',
  'date',
  'ipv4',
  'ipv6',
]);

const JSON_FORMATS: Readonly<Record<string, string>> = {
  guid: 'uuid',
  url: 'uri',
  datetime: 'date-time',
};

function formatPatterns(node: z.core.$ZodType): { sources: Set<string>; format: string | null } {
  const sources = new Set<string>();
  let jsonFormat: string | null = null;
  const def = node._zod.def as { checks?: z.core.$ZodCheck[] };
  const checks: unknown[] = [node, ...(def.checks ?? [])];
  for (const check of checks) {
    const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (checkDef?.['check'] !== 'string_format') continue;
    const format = checkDef['format'];
    const pattern = checkDef['pattern'];
    if (typeof format === 'string' && FORMATS_WITHOUT_PATTERN.has(format)) {
      if (pattern instanceof RegExp) sources.add(pattern.source);
      jsonFormat ??= JSON_FORMATS[format] ?? format;
    }
  }
  return { sources, format: jsonFormat };
}

function keepConverterRules(node: z.core.$ZodType, json: JsonNode): void {
  const def = node._zod.def;
  switch (def.type) {
    case 'object': {
      const catchall = (def as z.core.$ZodObjectDef).catchall;
      if (catchall == null) {
        json['additionalProperties'] = false;
      } else if (catchall._zod.def.type === 'unknown' || catchall._zod.def.type === 'any') {
        json['additionalProperties'] = true;
      }
      break;
    }
    case 'string': {
      // Ajv knows no such formats: the pattern alone carries the rule.
      if (
        json['format'] === 'starts_with' ||
        json['format'] === 'ends_with' ||
        json['format'] === 'includes'
      ) {
        delete json['format'];
      }
      const { sources, format } = formatPatterns(node);
      if (sources.size === 0) break;
      // A custom pattern replaces the format in Zod's output: keep both.
      if (format != null && json['format'] == null) json['format'] = format;
      if (typeof json['pattern'] === 'string' && sources.has(json['pattern'])) {
        delete json['pattern'];
      }
      const allOf = json['allOf'];
      if (Array.isArray(allOf)) {
        const rest = (allOf as JsonNode[]).filter(
          (entry) => typeof entry['pattern'] !== 'string' || !sources.has(entry['pattern']),
        );
        if (rest.length === 0) delete json['allOf'];
        else if (rest.length === 1 && typeof rest[0]?.['pattern'] === 'string') {
          delete json['allOf'];
          json['pattern'] = rest[0]['pattern'];
        } else json['allOf'] = rest;
      }
      break;
    }
    case 'number': {
      if (json['minimum'] === Number.MIN_SAFE_INTEGER) delete json['minimum'];
      if (json['maximum'] === Number.MAX_SAFE_INTEGER) delete json['maximum'];
      break;
    }
    case 'date': {
      json['type'] = 'string';
      json['format'] = 'date-time';
      break;
    }
    default:
      break;
  }
}

/**
 * Zod renders `z.enum([...]).nullable()` as
 * `{ type: 'string', enum: [...], nullable: true }`. Ajv applies `enum`
 * independently of `nullable`, so a request that sends `null` fails
 * validation even though the zod schema allows it. OpenAPI 3.0 requires null
 * to be listed in `enum` for a nullable enum, so add it there.
 */
function allowNullInNullableEnums(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) allowNullInNullableEnums(item);
    return;
  }
  if (node == null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const values = record['enum'];
  if (record['nullable'] === true && Array.isArray(values) && !values.includes(null)) {
    values.push(null);
  }
  for (const value of Object.values(record)) allowNullInNullableEnums(value);
}

/**
 * zodSchema() hands Fastify a JSON Schema, so Ajv validates the request and Zod
 * never runs on it. the JSON Schema has no `.refine()` and `.superRefine()`,
 * and Ajv leaves the value as sent where Zod would change it: `.transform()`,
 * `.trim()`, `.toLowerCase()`, `z.coerce.date()`. A route whose request schema
 * (body, querystring or params) carries any of these parses the Ajv-validated
 * value with this and uses the result, never the raw request value. Throws a
 * 400 VALIDATION_ERROR with the first failing rule's message.
 */
export function parseZodRequest<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(issue?.message ?? 'Validation failed', result.error.issues);
  }
  return result.data;
}

/**
 * A preValidation hook that refuses a JSON object body with a key the schema
 * does not name: 400 VALIDATION_ERROR naming the key. Fastify's Ajv runs with
 * `removeAdditional`, so without it an unknown key (a misspelled field, or a
 * setting that has its own route) is dropped and the request answers 200
 * without doing what the caller asked. `hints` adds a sentence for a key that
 * belongs to another route.
 */
export function rejectUnknownBodyKeys(
  schema: z.ZodObject,
  hints: Record<string, string> = {},
): (request: FastifyRequest) => Promise<void> {
  const known = new Set(Object.keys(schema.shape));
  return (request) => {
    const body = request.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return Promise.resolve();
    }
    const unknown = Object.keys(body).filter((key) => !known.has(key));
    const first = unknown[0];
    if (first == null) return Promise.resolve();
    const hint = hints[first];
    return Promise.reject(
      new ValidationError(
        `Unknown field ${first}${hint != null ? `: ${hint}` : ''}`,
        unknown.map((key) => ({ path: [key], message: 'Unknown field' })),
      ),
    );
  };
}
