// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AnyZodObject, z, ZodTypeAny } from 'zod';
import type { FastifyRequest } from 'fastify';
import { ValidationError } from '@evtivity/lib';

export function zodSchema(schema: ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'openApi3',
    $refStrategy: 'none',
  });
  allowNullInNullableEnums(jsonSchema);
  return jsonSchema;
}

/**
 * zod-to-json-schema renders `z.enum([...]).nullable()` as
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
 * never runs on it. zod-to-json-schema drops `.refine()` and `.superRefine()`,
 * and Ajv leaves the value as sent where Zod would change it: `.transform()`,
 * `.trim()`, `.toLowerCase()`, `z.coerce.date()`. A route whose request schema
 * (body, querystring or params) carries any of these parses the Ajv-validated
 * value with this and uses the result, never the raw request value. Throws a
 * 400 VALIDATION_ERROR with the first failing rule's message.
 */
export function parseZodRequest<T extends ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(issue?.message ?? 'Validation failed', result.error.issues);
  }
  return result.data as z.output<T>;
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
  schema: AnyZodObject,
  hints: Record<string, string> = {},
): (request: FastifyRequest) => Promise<void> {
  const known = new Set(Object.keys(schema.shape as Record<string, unknown>));
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
